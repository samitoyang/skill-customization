import { discoveryPerformanceChannel } from "../../src/performance-diagnostics.js";

export async function captureDiscoveryWork(callback) {
  if (typeof callback !== "function") {
    throw new TypeError("discovery work callback must be a function");
  }
  const metrics = {};
  const listener = ({ name, amount = 1 }) => {
    metrics[name] = (metrics[name] ?? 0) + amount;
  };
  discoveryPerformanceChannel.subscribe(listener);
  try {
    return { result: await callback(), metrics };
  } finally {
    discoveryPerformanceChannel.unsubscribe(listener);
  }
}
