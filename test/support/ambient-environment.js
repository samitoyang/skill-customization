export async function withAmbientEnvironment({ cwd, env }, callback) {
  if (typeof cwd !== "string" || !cwd) {
    throw new TypeError("ambient environment cwd must be explicit");
  }
  if (!env || typeof env !== "object" || Array.isArray(env)) {
    throw new TypeError("ambient environment env must be an object");
  }

  const previousCwd = process.cwd();
  const previousEnv = { ...process.env };
  try {
    process.chdir(cwd);
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, env);
    return await callback();
  } finally {
    process.chdir(previousCwd);
    for (const name of Object.keys(process.env)) delete process.env[name];
    Object.assign(process.env, previousEnv);
  }
}
