import { channel } from "node:diagnostics_channel";

export const discoveryPerformanceChannel = channel(
  "skill-customization.discovery.performance",
);

export function publishDiscoveryPerformanceMetric(name, amount = 1) {
  if (!discoveryPerformanceChannel.hasSubscribers) return;
  discoveryPerformanceChannel.publish({ name, amount });
}
