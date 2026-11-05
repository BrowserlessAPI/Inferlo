// A stand-in for Encore's native runtime library (encore-runtime.node), which only exists inside the Encore
// CLI. encore.dev loads the library named by ENCORE_RUNTIME_LIB when it is imported; this one lets the tests
// import the real encore.dev package and run its own RawRequest and RawResponse classes, the objects Encore
// hands to raw endpoints. Secrets resolve to "test-<name>". Everything else is a no-op.
const fs = require("node:fs");
const path = require("node:path");

const pkg = JSON.parse(fs.readFileSync(path.join(__dirname, "../../../node_modules/encore.dev/package.json"), "utf8"));
const noop = () => undefined;

function stub(statics = {}, methods = {}) {
  const Instance = class {
    constructor() {
      return new Proxy({}, { get: (_target, key) => (key in methods ? methods[key] : key === "then" ? undefined : noop) });
    }
  };
  return new Proxy(Instance, { get: (target, key) => (key in statics ? statics[key] : key in target ? target[key] : noop) });
}

const names = [
  "APICallError", "ApiCallError", "BodyReader", "Bucket", "BucketObject", "CacheCluster", "CloudProvider", "Cursor", "Decimal",
  "EnvironmentType", "Gateway", "ListEntry", "ListIterator", "LogLevel", "Logger", "MetricType", "MetricsRegistry", "ObjectAttrs",
  "ObjectErrorKind", "PubSubSubscription", "PubSubTopic", "QueryArgs", "Request", "ResponseWriter", "Row", "SQLConn", "SQLDatabase",
  "Secret", "Sink", "Socket", "SqlConn", "SqlDatabase", "Stream", "Transaction", "TypedObjectError", "WebSocketClient",
];
for (const name of names) module.exports[name] = stub();
module.exports.Runtime = stub({ version: () => "v" + pkg.version }, { secret: (name) => ({ cached: () => "test-" + name }) });
