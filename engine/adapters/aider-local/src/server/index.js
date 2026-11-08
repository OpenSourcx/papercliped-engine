import { type, models, agentConfigurationDoc } from "../index.js";
import { execute } from "./execute.js";
import { testEnvironment } from "./test.js";

export function createServerAdapter() {
  return { type, execute, testEnvironment, models, agentConfigurationDoc };
}

export { execute, testEnvironment };
