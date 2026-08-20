function isRecord(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function normalizeNpmPackReport(report) {
  const packageReports = Array.isArray(report)
    ? report
    : isRecord(report)
      ? Object.values(report)
      : [];

  if (
    packageReports.length !== 1 ||
    !isRecord(packageReports[0]) ||
    !Array.isArray(packageReports[0].files)
  ) {
    throw new Error("npm pack returned an unexpected report");
  }

  return packageReports[0];
}
