import ora from "ora";

export interface StepFeedback {
  readonly logger: Pick<Console, "log">;
  start(text: string): void;
  update(text: string): void;
  info(text: string): void;
  succeed(text: string): void;
  fail(text: string): void;
  stop(): void;
}

export function createStepFeedback(): StepFeedback {
  const spinner = process.stdout.isTTY ? ora() : undefined;

  const update = (text: string): void => {
    if (spinner) {
      spinner.text = text;
      return;
    }
    console.log(text);
  };

  return {
    logger: {
      log(message: string) {
        update(message);
      },
    },
    start(text: string) {
      if (spinner) {
        spinner.start(text);
        return;
      }
      console.log(text);
    },
    update(text: string) {
      update(text);
    },
    info(text: string) {
      if (spinner) {
        spinner.info(text);
        return;
      }
      console.log(text);
    },
    succeed(text: string) {
      if (spinner) {
        spinner.succeed(text);
        return;
      }
      console.log(text);
    },
    fail(text: string) {
      if (spinner) {
        spinner.fail(text);
        return;
      }
      console.error(text);
    },
    stop() {
      spinner?.stop();
    },
  };
}

export async function runStep<T>(
  feedback: StepFeedback,
  text: string,
  action: () => Promise<T>,
  successText = text,
): Promise<T> {
  feedback.start(text);
  try {
    const result = await action();
    feedback.succeed(successText);
    return result;
  } catch (error) {
    feedback.fail(text);
    throw error;
  }
}
