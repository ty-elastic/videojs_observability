FROM nginx:1.21.6-alpine
RUN apk add --no-cache libstdc++

COPY --from=ghcr.io/nginxinc/amd64/ngx_otel_module:linux-musl-nginx-1.21.6 /usr/lib/nginx/modules/otel_ngx_module.so /usr/lib/nginx/modules/otel_ngx_module.so

COPY cors.rules /etc/nginx/cors.rules
COPY nginx.conf /etc/nginx/nginx.conf
COPY otel-nginx.toml /conf/otel-nginx.toml