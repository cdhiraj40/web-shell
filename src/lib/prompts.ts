import { stdin as input, stdout as output } from "node:process";

interface TextPromptOptions {
  defaultValue?: string;
  validate?: (value: string) => string | undefined;
}

export interface PromptSession {
  text(message: string, options?: TextPromptOptions): Promise<string>;
  confirm(message: string, defaultValue?: boolean): Promise<boolean>;
  password(message: string, options?: TextPromptOptions): Promise<string>;
  isInteractive(): boolean;
  close(): void;
}

export class Prompter implements PromptSession {
  private readonly interactive: boolean;

  constructor(interactive?: boolean) {
    this.interactive = interactive ?? Boolean(input.isTTY && output.isTTY);
  }

  async text(message: string, options: TextPromptOptions = {}): Promise<string> {
    if (!this.interactive) {
      if (options.defaultValue !== undefined) {
        return options.defaultValue;
      }
      throw new Error(`Missing required value for "${message}" in non-interactive mode.`);
    }

    while (true) {
      const promptInput = await loadPromptInput();
      const rawValue = await promptInput({
        message,
        default: options.defaultValue,
        validate: (value: string) => options.validate?.(value) ?? true,
      });
      const value = rawValue.trim() || options.defaultValue || "";
      const validationError = options.validate?.(value);
      if (!validationError) {
        return value;
      }
      console.error(`Error: ${validationError}`);
    }
  }

  isInteractive(): boolean {
    return this.interactive;
  }

  async confirm(message: string, defaultValue = true): Promise<boolean> {
    if (!this.interactive) {
      return defaultValue;
    }
    const promptConfirm = await loadPromptConfirm();
    return promptConfirm({
      message,
      default: defaultValue,
    });
  }

  async password(message: string, options: TextPromptOptions = {}): Promise<string> {
    if (!this.interactive) {
      if (options.defaultValue !== undefined) {
        return options.defaultValue;
      }
      throw new Error(`Missing required value for "${message}" in non-interactive mode.`);
    }

    while (true) {
      const promptPassword = await loadPromptPassword();
      const value = await promptPassword({
        message,
        mask: true,
        validate: (candidate: string) => options.validate?.(candidate) ?? true,
      });
      const finalValue = value.trim() || options.defaultValue || "";
      const validationError = options.validate?.(finalValue);
      if (!validationError) {
        return finalValue;
      }
      console.error(`Error: ${validationError}`);
    }
  }

  close(): void {
    // No-op. @inquirer/prompts manages its own lifecycle per prompt call.
  }
}

type PromptLoader = typeof import("@inquirer/prompts");
let promptModulePromise: Promise<PromptLoader> | undefined;

async function loadPromptModule(): Promise<PromptLoader> {
  promptModulePromise ??= import("@inquirer/prompts");
  return await promptModulePromise;
}

async function loadPromptInput(): Promise<PromptLoader["input"]> {
  return (await loadPromptModule()).input;
}

async function loadPromptConfirm(): Promise<PromptLoader["confirm"]> {
  return (await loadPromptModule()).confirm;
}

async function loadPromptPassword(): Promise<PromptLoader["password"]> {
  return (await loadPromptModule()).password;
}
