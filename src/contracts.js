export const SUPPORTED_HELPER_CONTRACTS = Object.freeze(["1"]);

export function isValidHelperContract(contract) {
  return typeof contract === "string" && /^[1-9][0-9]*$/.test(contract);
}

export function helperContractSupport(contract, packageVersion) {
  const valid = isValidHelperContract(contract);
  return {
    compatible: valid && SUPPORTED_HELPER_CONTRACTS.includes(contract),
    requested_contract: contract ?? null,
    supported_contracts: [...SUPPORTED_HELPER_CONTRACTS],
    package_version: packageVersion,
  };
}
