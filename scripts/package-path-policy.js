const forbiddenPathComponents = new Set([
  ".git",
  ".github",
  ".internal",
  "AGENTS.md",
  "CONTEXT.md",
  "scripts",
  "test",
]);

export function isForbiddenPackagePath(file) {
  return file.split(/[\\/]/u).some((component) =>
    forbiddenPathComponents.has(component),
  );
}
