# Helper contract 2

Contract 2 is the complete customization lifecycle contract. It includes every behavior in [helper contract 1](helper-contract-1.md), plus canonical dispatcher rendering. Helper `v0.1.1` supports both contracts so existing contract-1 dispatchers remain compatible, while newly generated dispatchers and overlay or fork creation negotiate only contract 2.

| Added command | Contract-2 behavior |
| --- | --- |
| `render-dispatcher` | Validate approved skill metadata and render the canonical thin dispatcher for one semantic overlay or fork. The rendered dispatcher negotiates only contract 2. |

If contract 2 is unavailable, incompatible, or malformed, a new dispatcher delegates once to its customization type's maintenance skill and executes no customization instructions. Maintenance skills use the same installed, approved local-checkout, then approved registry selection order before creation.

The renderer interface accepts only the customization type and approved frontmatter. Helper fallback policy, package versions, source instructions, concrete paths, and context policy stay outside generated dispatchers. The named `helper contract 2:` tests and dispatcher-renderer tests enforce this added public surface; the contract-1 tests and goldens continue to enforce the inherited behavior.
