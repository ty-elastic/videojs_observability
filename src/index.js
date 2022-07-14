/*
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 *      https://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

const { ValueType } = require('@opentelemetry/api-metrics');
const { DiagConsoleLogger, DiagLogLevel, diag, SpanKind, context, SpanStatusCode, propagation, trace } = require('@opentelemetry/api');
const { OTLPMetricExporter } = require('@opentelemetry/exporter-metrics-otlp-http');
const { OTLPTraceExporter } = require('@opentelemetry/exporter-trace-otlp-http');
const { AggregationTemporality, MeterProvider, LastValueAggregation, InstrumentType } = require('@opentelemetry/sdk-metrics-base');
const { Resource } = require('@opentelemetry/resources');
const { B3Propagator } = require('@opentelemetry/propagator-b3');
const { SemanticResourceAttributes } = require('@opentelemetry/semantic-conventions');
const { OneShotExportingMetricReader } = require('./OneShotExportingMetricReader');
const { SimpleSpanProcessor } = require('@opentelemetry/sdk-trace-base');
const { ZoneContextManager } = require('@opentelemetry/context-zone');
const { registerInstrumentations } = require('@opentelemetry/instrumentation');
const { XMLHttpRequestInstrumentation } = require('@opentelemetry/instrumentation-xml-http-request');
const { WebTracerProvider } = require('@opentelemetry/sdk-trace-web');
import eventTracking from 'videojs-event-tracking';
import { v4 as uuidv4 } from 'uuid';

require('file-loader?name=[name].[ext]!./index.html');

const SERVICE_NAME = 'videojs-player';
const METRICS_OTLP_HTTP_ENDPOINT = 'http://' + location.hostname + ':55690/v1/metrics';
const TRACES_OTLP_HTTP_ENDPOINT = 'http://' + location.hostname + ':55690/v1/traces';
const CONTENT_URL = 'http://' + location.hostname + ':8080/hls/test.m3u8';

const INSTANCE_ID = uuidv4();

// a map to hold all of our meters
var meterBags = new Map();
// stats to hold pushed metrics for later callback observation
var startStats = {};
var trackingStats = { vhs: {} };
var performanceStats = { vhs: {} };
// the tracing span for the playback session
var playerSpan = null;

// Optional and only needed to see the internal diagnostic logging (during development)
diag.setLogger(new DiagConsoleLogger(), DiagLogLevel.DEBUG);

// create a meters bag (our own data structure)
function createMeterBag(metricExporter, name) {
  let meterProvider = new MeterProvider({
    // add common labels/resources
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: SERVICE_NAME,
      [SemanticResourceAttributes.SERVICE_VERSION]: videojs.VERSION,
      'player.instance.id': INSTANCE_ID
    })
  });
  meterProvider.addView(
    {
      // force last value aggregation
      aggregation: new LastValueAggregation(),
    })

  // observe only on flush (on-demand)
  let reader = new OneShotExportingMetricReader({
    exporter: metricExporter,
    exportTimeoutMillis: 5000
  });
  meterProvider.addMetricReader(reader);

  // create our meterBag and store it globally
  let meterBag = { reader: reader, meter: meterProvider.getMeter(name), meters: new Map() };
  meterBags.set(name, meterBag);
  return meterBag;
}

// observe common metrics
function observe(meterBag, stats, attributes, batchObservableResult) {
  if (stats.secondsToLoad)
    batchObservableResult.observe(meterBag.meters.get('load.time'), stats.secondsToLoad, attributes);

  if (stats.seekCount)
    batchObservableResult.observe(meterBag.meters.get('seek.count'), stats.seekCount, attributes);
  if (stats.pauseCount)
    batchObservableResult.observe(meterBag.meters.get('pause.count'), stats.pauseCount, attributes);
  if (stats.currentTime)
    batchObservableResult.observe(meterBag.meters.get('play.time'), stats.currentTime, attributes);
  if (stats.duration)
    batchObservableResult.observe(meterBag.meters.get('duration.time'), stats.duration, attributes);
  if (stats.currentTime && stats.duration)
    batchObservableResult.observe(meterBag.meters.get('play.percent'), (stats.currentTime / stats.duration) * 100.0, attributes);
  if (stats.errorCount)
    batchObservableResult.observe(meterBag.meters.get('error.count'), stats.errorCount, attributes);

  if (stats.bufferCount)
    batchObservableResult.observe(meterBag.meters.get('buffer.count'), stats.bufferCount, attributes);
  if (stats.watchedDuration)
    batchObservableResult.observe(meterBag.meters.get('watched.time'), stats.watchedDuration, attributes);
  if (stats.bufferDuration)
    batchObservableResult.observe(meterBag.meters.get('buffer.time'), stats.bufferDuration, attributes);

  if (stats.vhs) {
    batchObservableResult.observe(meterBag.meters.get('segment.bandwidth'), stats.vhs.bandwidth, attributes);
    batchObservableResult.observe(meterBag.meters.get('segment.requests.count'), stats.vhs.mediaRequests, attributes);
    batchObservableResult.observe(meterBag.meters.get('segment.aborted.count'), stats.vhs.mediaRequestsAborted, attributes);
    batchObservableResult.observe(meterBag.meters.get('segment.timeout.count'), stats.vhs.mediaRequestsTimedout, attributes);
    batchObservableResult.observe(meterBag.meters.get('segment.error.count'), stats.vhs.mediaRequestsErrored, attributes);
    batchObservableResult.observe(meterBag.meters.get('segment.transfer.time'), stats.vhs.mediaTransferDuration, attributes);
    batchObservableResult.observe(meterBag.meters.get('segment.download.data'), stats.vhs.mediaBytesTransferred, attributes);
    batchObservableResult.observe(meterBag.meters.get('segment.download.time'), stats.vhs.mediaSecondsLoaded, attributes);
    batchObservableResult.observe(meterBag.meters.get('video.frames.count'), stats.vhs.videoPlaybackQuality.totalVideoFrames, attributes);
    batchObservableResult.observe(meterBag.meters.get('video.dropped.count'), stats.vhs.videoPlaybackQuality.droppedVideoFrames, attributes);
  }
}

// report start data
function reportStart(data) {
  // copy to global
  for (const [key, value] of Object.entries(data)) {
    startStats[key] = value;
  }
  // force on-demand flush/read
  meterBags.get('start').reader.forceFlush();
}
// callback for on-demand flush/read
async function startObservableCallback(batchObservableResult) {
  observe(meterBags.get('start'), startStats, { 'player.source.url': window.player.currentSrc() }, batchObservableResult);
}

// report quarterly tracking data
function reportTracking(quarter, data, vhsStats) {
  // copy to global
  for (const [key, value] of Object.entries(data)) {
    trackingStats[key] = value;
  }
  for (const [key, value] of Object.entries(vhsStats)) {
    trackingStats.vhs[key] = value;
  }
  trackingStats['quarter'] = quarter;
  // force on-demand flush/read
  meterBags.get('tracking').reader.forceFlush();
}
// callback for on-demand flush/read
async function trackingObservableCallback(batchObservableResult) {
  console.log(trackingStats)
  observe(meterBags.get('tracking'), trackingStats, { 'player.source.url': window.player.currentSrc(), 'quarter': trackingStats.quarter }, batchObservableResult);
}

// report performance (end of stream) data
function reportPerformance(data, vhsStats) {
  for (let [key, value] of Object.entries(data)) {
    // rename to common key names
    if (key === 'initialLoadTime') key = 'secondsToLoad';
    if (key === 'totalDuration') key = 'duration';
    performanceStats[key] = value;
  }
  for (const [key, value] of Object.entries(vhsStats)) {
    performanceStats.vhs[key] = value;
  }
  // force on-demand flush/read
  meterBags.get('performance').reader.forceFlush();
}
// callback for on-demand flush/read
async function performanceObservableCallback(batchObservableResult) {
  observe(meterBags.get('performance'), performanceStats, { 'player.source.url': window.player.currentSrc() }, batchObservableResult);
}

// create a meter
function createMeter(meterBag, name, type, options, observableCallback) {
  var meter;
  switch (type) {
    case InstrumentType.HISTOGRAM:
      meter = meterBag.meter.createHistogram(name, options);
      break;

    case InstrumentType.COUNTER:
      meter = meterBag.meter.createCounter(name, options);
      break;

    case InstrumentType.OBSERVABLE_COUNTER:
      meter = meterBag.meter.createObservableCounter(name, options);
      if (observableCallback)
        meter.addCallback(observableCallback);
      break;

    case InstrumentType.OBSERVABLE_GAUGE:
      meter = meterBag.meter.createObservableGauge(name, options);
      if (observableCallback)
        meter.addCallback(observableCallback);
      break;
  }
  // store it in the bag for later retrieval by name
  meterBag.meters.set(name, meter);
  return meter;
}

// create common meters
function createCommonMeters(meterBag) {
  createMeter(meterBag, 'seek.count', InstrumentType.OBSERVABLE_COUNTER,
    {
      description: 'total number of seek events triggered'
    });
  createMeter(meterBag, 'pause.count', InstrumentType.OBSERVABLE_COUNTER,
    {
      description: 'total number of pause events triggered'
    });
  createMeter(meterBag, 'duration.time', InstrumentType.OBSERVABLE_GAUGE,
    {
      description: 'total duration of video',
      unit: 'seconds'
    });
  createMeter(meterBag, 'error.count', InstrumentType.OBSERVABLE_COUNTER,
    {
      description: 'total number of error events triggered'
    });

  createMeter(meterBag, 'segment.bandwidth', InstrumentType.OBSERVABLE_GAUGE,
    {
      description: 'Rate of the last segment download in bits/second',
      unit: 'bits per second'
    });
  createMeter(meterBag, 'segment.requests.count', InstrumentType.OBSERVABLE_COUNTER,
    {
      description: 'total number of media segment requests'
    });
  createMeter(meterBag, 'segment.aborted.count', InstrumentType.OBSERVABLE_COUNTER,
    {
      description: 'total number of aborted media segment requests'
    });
  createMeter(meterBag, 'segment.timeout.count', InstrumentType.OBSERVABLE_COUNTER,
    {
      description: 'total number of timedout media segment requests'
    });
  createMeter(meterBag, 'segment.error.count', InstrumentType.OBSERVABLE_COUNTER,
    {
      description: 'total number of errored media segment requests'
    });
  createMeter(meterBag, 'segment.transfer.time', InstrumentType.OBSERVABLE_GAUGE,
    {
      description: 'total time spent downloading media segments in milliseconds',
      unit: 'milliseconds'
    });
  createMeter(meterBag, 'segment.download.data', InstrumentType.OBSERVABLE_GAUGE,
    {
      description: 'total number of content bytes downloaded',
      unit: 'bytes'
    });
  createMeter(meterBag, 'segment.download.time', InstrumentType.OBSERVABLE_GAUGE,
    {
      description: 'total number of content seconds downloaded',
      unit: 'seconds'
    });
  createMeter(meterBag, 'video.frames.count', InstrumentType.OBSERVABLE_COUNTER,
    {
      description: 'total video frame count'
    });
  createMeter(meterBag, 'video.dropped.count', InstrumentType.OBSERVABLE_COUNTER,
    {
      description: 'dropped video frame count'
    });
}

// setup metrics
function setupMetrics() {
  // create a otlp/http exporter
  const metricExporter = new OTLPMetricExporter({
    url: METRICS_OTLP_HTTP_ENDPOINT,
    // only send new metrics on each push
    temporalityPreference: AggregationTemporality.DELTA
  });

  // create a meter bag for startup metrics
  let meterBag = createMeterBag(metricExporter, 'start');
  createMeter(meterBag, 'load.time', InstrumentType.OBSERVABLE_GAUGE, {
    description: 'seconds it took for the initial frame to appear',
    unit: 'seconds',
    valueType: ValueType.DOUBLE,
  });
  // add observeable callback
  meterBag.meter.addBatchObservableCallback(startObservableCallback, Array.from(meterBag.meters.values()));

  // create a meter bag for tracking metrics
  meterBag = createMeterBag(metricExporter, 'tracking');
  // add common meters
  createCommonMeters(meterBag);
  // add meters unique for tracking
  createMeter(meterBag, 'play.time', InstrumentType.OBSERVABLE_COUNTER,
    {
      description: 'current second video is on',
      unit: 'seconds'
    });
  createMeter(meterBag, 'play.percent', InstrumentType.OBSERVABLE_GAUGE,
    {
      description: '% played',
      valueType: ValueType.DOUBLE
    });
  // add observeable callback
  meterBag.meter.addBatchObservableCallback(trackingObservableCallback, Array.from(meterBag.meters.values()));

  // create a meter bag for performance metrics
  meterBag = createMeterBag(metricExporter, 'performance');
  // add common meters
  createCommonMeters(meterBag);
  // add meters unique for performance
  createMeter(meterBag, 'buffer.count', InstrumentType.OBSERVABLE_COUNTER,
    {
      description: 'total number of buffer events triggered'
    });
  createMeter(meterBag, 'watched.time', InstrumentType.OBSERVABLE_GAUGE,
    {
      description: 'total number of seconds watched, this excluses seconds a user has seeked past',
      unit: 'seconds'
    });
  createMeter(meterBag, 'buffer.time', InstrumentType.OBSERVABLE_COUNTER,
    {
      description: 'total seconds that buffering has occured',
      unit: 'seconds'
    });
  meterBag.meter.addBatchObservableCallback(performanceObservableCallback, Array.from(meterBag.meters.values()));
}

// setup tracing
function setupTracing() {
  const tracingProvider = new WebTracerProvider({
    // add common labels/resources
    resource: new Resource({
      [SemanticResourceAttributes.SERVICE_NAME]: SERVICE_NAME,
      [SemanticResourceAttributes.SERVICE_VERSION]: videojs.VERSION,
      'player.instance.id': INSTANCE_ID
    }),
  });

  const tracingExporter = new OTLPTraceExporter({
    url: TRACES_OTLP_HTTP_ENDPOINT,
  });
  tracingProvider.addSpanProcessor(new SimpleSpanProcessor(tracingExporter));

  tracingProvider.register({
    contextManager: new ZoneContextManager(),
    // b3 propagator is needed to send parent spanid to nginx on segment requests
    propagator: new B3Propagator(),
  });

  // auto instrument segment requests with spans
  let xhrInstrumentation = new XMLHttpRequestInstrumentation({
    propagateTraceHeaderCorsUrls: [
      new RegExp('.+'),
    ],
  });
  // we need to hook _createSpan to set context = to the parent player span
  // context we set when we start playback
  xhrInstrumentation.__createSpan = xhrInstrumentation._createSpan;
  xhrInstrumentation._createSpan = (xhr, url, method) => {
    if (playerSpan) {
      // set context to properly set parent spanid
      context.with(trace.setSpan(context.active(), playerSpan), () => {
        xhrInstrumentation.__createSpan(xhr, url, method);
      });
    } else {
      xhrInstrumentation.__createSpan(xhr, url, method);
    }
  }

  registerInstrumentations({
    instrumentations: [
      xhrInstrumentation
    ],
  });

  // create a tracer
  let tracer = tracingProvider.getTracer('player');
  return tracer;
}

// main starting point
(async function (window, videojs) {
  setupMetrics();
  let tracer = setupTracing();

  // register the eventTracking plugin for periodic stats
  videojs.registerPlugin('eventTracking', eventTracking);

  // create our videoJS player
  let player = window.player = videojs('videojs_observability', {
    sources: [
      { src: CONTENT_URL }
    ]
  });

  // hook initial file load to start span
  player.on('loadstart', function (e, data) {
    startStats = {};
    trackingStats = { vhs: {} };
    performanceStats = { vhs: {} };

    if (player.tech().vhs) {
      player.tech().vhs.xhr.beforeRequest = function (options) {
        // since nginx otel doesn't yet support baggage, we manually
        // stick some attributes into request headers
        options.headers["x-playback-instance-id"] = INSTANCE_ID;
        options.headers["x-playback-source-url"] = player.currentSrc();
        return options;
      };
    }

    // start a new span
    playerSpan = tracer.startSpan('play', { attributes: { 'player.source.url': player.currentSrc() }, kind: SpanKind.CLIENT });
  });

  player.eventTracking({
    // fired at end of playback
    performance: function (data) {
      // report performance
      reportPerformance(data, player.tech().vhs.stats);
      // set success result on span
      if (performanceStats.errorCount == 0) {
        playerSpan.setStatus({
          code: SpanStatusCode.OK
        });
      }
      playerSpan.end();
    },
  });

  // fired when file actually starts playback
  player.on('tracking:firstplay', function (e, data) {
    playerSpan.addEvent('start');
    reportStart(data);
  });

  // fired on playback error
  player.on('error', function (e) {
    // inc error count
    trackingStats.errorCount++;
    performanceStats.errorCount++;

    // add error event
    playerSpan.addEvent('error', { 'message': e.message });

    // set error result on span
    playerSpan.setStatus({
      code: SpanStatusCode.ERROR,
      message: e.message,
    });
  });

  // fired after 25% playback
  player.on('tracking:first-quarter', function (e, data) {
    playerSpan.addEvent('first-quarter');
    reportTracking('first', data, player.tech().vhs.stats);
  });

  // fired after 50% playback
  player.on('tracking:second-quarter', function (e, data) {
    playerSpan.addEvent('second-quarter');
    reportTracking('second', data, player.tech().vhs.stats);
  });

  // fired after 75% playback
  player.on('tracking:third-quarter', function (e, data) {
    playerSpan.addEvent('third-quarter');
    reportTracking('third', data, player.tech().vhs.stats);
  });

  // fired at 100% playback
  player.on('tracking:fourth-quarter', function (e, data) {
    playerSpan.addEvent('fourth-quarter');
    reportTracking('fourth', data, player.tech().vhs.stats);
  });

}(window, window.videojs));
