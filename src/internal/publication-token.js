const publicationTokens = new WeakMap();

function normalizedPaths(values) {
  return [...new Set(values.flat().filter((value) => typeof value === "string"))]
    .sort((left, right) => left.localeCompare(right, "en"));
}

// This is deliberately an internal seam.  Preflight returns the execution
// result itself; recovery can retrieve its CAS hand-off only through this
// module, so neither serialization nor ordinary property access exposes it.
export function attachPublicationToken(result, {
  paths = [],
  treePaths = [],
  stateTreePaths = [],
  bindings = [],
} = {}) {
  publicationTokens.set(result, Object.freeze({
    paths: Object.freeze(normalizedPaths(paths)),
    treePaths: Object.freeze(normalizedPaths(treePaths)),
    stateTreePaths: Object.freeze(normalizedPaths(stateTreePaths)),
    bindings: Object.freeze(bindings.map(({ key, binding }) => Object.freeze({ key, binding }))),
  }));
  return result;
}

export function publicationTokenFor(result) {
  return publicationTokens.get(result);
}
