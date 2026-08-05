export class SkillCustomizationError extends Error {
  constructor(message, { code = "SKILL_CUSTOMIZATION_ERROR", details } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.code = code;
    if (details !== undefined) this.details = details;
  }
}

export class DescriptorError extends SkillCustomizationError {
  constructor(message, details) {
    super(message, { code: "INVALID_DESCRIPTOR", details });
  }
}

export class DiscoveryError extends SkillCustomizationError {}
export class BindingError extends SkillCustomizationError {}
export class ReconciliationError extends SkillCustomizationError {}
