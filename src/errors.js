/**
 * @typedef {object} SkillCustomizationErrorOptions
 * @property {string} [code]
 * @property {unknown} [details]
 */

export class SkillCustomizationError extends Error {
  /**
   * @param {string} message
   * @param {SkillCustomizationErrorOptions} [options]
   */
  constructor(message, { code = "SKILL_CUSTOMIZATION_ERROR", details } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export class DescriptorError extends SkillCustomizationError {
  /** @param {string} message @param {unknown} details */
  constructor(message, details) {
    super(message, { code: "INVALID_DESCRIPTOR", details });
  }
}

export class DiscoveryError extends SkillCustomizationError {}
export class BindingError extends SkillCustomizationError {}
export class ReconciliationError extends SkillCustomizationError {}
