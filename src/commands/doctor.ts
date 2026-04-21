import path from "node:path";
import { DoctorRuntime, runDoctor } from "../lib/toolchain.js";
import { createStepFeedback, runStep } from "../lib/ui.js";

export interface DoctorCommandOptions {
  projectDir?: string;
  sdkDir?: string;
  fix?: boolean;
}

export async function runDoctorCommand(
  directory: string | undefined,
  options: DoctorCommandOptions,
  runtime?: DoctorRuntime,
): Promise<void> {
  const projectDirectory = path.resolve(process.cwd(), directory ?? options.projectDir ?? ".");
  const feedback = createStepFeedback();
  await runStep(
    feedback,
    options.fix ? "Checking and fixing Android toolchain..." : "Checking Android toolchain...",
    () =>
      runDoctor(
        {
          projectDirectory,
          sdkDir: options.sdkDir,
          fix: options.fix,
        },
        {
          ...runtime,
          logger: feedback.logger,
        },
      ),
    options.fix ? "Android toolchain is ready." : "Android toolchain check complete.",
  );
}
