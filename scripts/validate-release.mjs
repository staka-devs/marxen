import { runValidate } from "./release-common.mjs";

const result = runValidate(process.argv.slice(2), process.env);
console.log(JSON.stringify(result));
console.log(`Validated ${result.version} at ${result.sha} with Integration run ${result.runId}.`);
