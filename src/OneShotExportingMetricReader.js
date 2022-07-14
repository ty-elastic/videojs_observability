"use strict";
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
Object.defineProperty(exports, "__esModule", { value: true });
exports.OneShotExportingMetricReader = void 0;
const api = require("@opentelemetry/api");
const core_1 = require("@opentelemetry/core");
const MetricReader_1 = require('@opentelemetry/sdk-metrics-base');

function callWithTimeout(promise, timeout) {
    let timeoutHandle;
    const timeoutPromise = new Promise(function timeoutFunction(_resolve, reject) {
        timeoutHandle = setTimeout(function timeoutHandler() {
            reject(new TimeoutError('Operation timed out.'));
        }, timeout);
    });
    return Promise.race([promise, timeoutPromise]).then(result => {
        clearTimeout(timeoutHandle);
        return result;
    }, reason => {
        clearTimeout(timeoutHandle);
        throw reason;
    });
}

/**
 * {@link MetricReader} which collects metrics based on a user-configurable time interval, and passes the metrics to
 * the configured {@link MetricExporter}
 */
class OneShotExportingMetricReader extends MetricReader_1.MetricReader {
    constructor(options) {
        var _b;
        super();
        if (options.exportTimeoutMillis !== undefined && options.exportTimeoutMillis <= 0) {
            throw Error('exportTimeoutMillis must be greater than 0');
        }
        this._exportTimeout = (_b = options.exportTimeoutMillis) !== null && _b !== void 0 ? _b : 30000;
        this._exporter = options.exporter;
    }
    async _runOnce() {
        const { resourceMetrics, errors } = await this.collect({});
        if (errors.length > 0) {
            api.diag.error('PeriodicExportingMetricReader: metrics collection errors', ...errors);
        }
        return new Promise((resolve, reject) => {
            this._exporter.export(resourceMetrics, result => {
                var _a;
                if (result.code !== core_1.ExportResultCode.SUCCESS) {
                    reject((_a = result.error) !== null && _a !== void 0 ? _a : new Error(`OneShotExportingMetricReader: metrics export failed (error ${result.error})`));
                }
                else {
                    resolve();
                }
            });
        });
    }
    onInitialized() {
    }
    async onForceFlush() {
       try {
            await (0, callWithTimeout)(this._runOnce(), this._exportTimeout);
        }
        catch (err) {
            if (err instanceof MetricReader_1.TimeoutError) {
                api.diag.error('Export took longer than %s milliseconds and timed out.', this._exportTimeout);
                return;
            }
            (0, core_1.globalErrorHandler)(err);
        }
    }
    async onShutdown() {
        await this._exporter.shutdown();
    }
    selectAggregationTemporality(instrumentType) {
        return this._exporter.selectAggregationTemporality(instrumentType);
    }
}
exports.OneShotExportingMetricReader = OneShotExportingMetricReader;
//# sourceMappingURL=PeriodicExportingMetricReader.js.map
