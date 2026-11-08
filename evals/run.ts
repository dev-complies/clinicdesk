/**
 * evals/run.ts
 *
 * CLI runner for the ClinicDesk evaluation suite.
 * Usage:
 *   npx tsx evals/run.ts [--category booking] [--id book-001] [--repeat 3] [--yes] [--allow-fallback]
 */

import crypto from "crypto";
import { execSync } from "child_process";
import * as dotenv from "dotenv";
import path from "path";
import { buildSystemPrompt } from "../src/lib/llm/system-prompt";
import { getAdminClient } from "../src/lib/supabase/admin";
import {
  insertEvalRunToDatabase,
  printEvalSummaryTable,
  writeReportFiles,
} from "./reporter";
import {
  fetchDatabaseCounts,
  loadAllScenarios,
  runScenario,
  RunnerOptions,
} from "./runner";
import { runSafetyGuard } from "./safety";
import { expandTemplate, maskPhone } from "./template";
import { DateTime } from "luxon";
import {
  CategorySummary,
  EvalRunReport,
  ScenarioRunResult,
  ScenarioStatus,
  ScenarioSummary,
} from "./types";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

function parseArgs(): RunnerOptions {
  const args = process.argv.slice(2);
  const options: RunnerOptions = {};

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--category" && i + 1 < args.length) {
      options.category = args[++i];
    } else if (arg === "--id" && i + 1 < args.length) {
      options.id = args[++i];
    } else if (arg === "--repeat" && i + 1 < args.length) {
      options.repeat = parseInt(args[++i], 10);
    } else if (arg === "--yes") {
      options.yes = true;
    } else if (arg === "--dry-run") {
      options.dryRun = true;
    } else if (arg === "--allow-fallback") {
      options.allowFallback = true;
    }
  }

  return options;
}

function getGitSha(): string {
  try {
    return execSync("git rev-parse HEAD", { stdio: ["ignore", "pipe", "ignore"] })
      .toString()
      .trim();
  } catch {
    return "unknown";
  }
}

function computeScenarioFilesHash(scenariosDir: string): string {
  const hash = crypto.createHash("sha256");
  const files = fs
    .readdirSync(scenariosDir)
    .filter((f) => f.endsWith(".json"))
    .sort();

  for (const file of files) {
    const content = fs.readFileSync(path.join(scenariosDir, file), "utf-8");
    hash.update(file);
    hash.update(content);
  }

  return hash.digest("hex").slice(0, 16);
}

import fs from "fs";

export async function main() {
  const options = parseArgs();
  const scenariosDir = path.resolve(process.cwd(), "evals/scenarios");

  console.log("\n[ClinicDesk Evals] Initializing evaluation runner...");

  // 1. Model Pinning (Error if neither EVAL_MODEL nor LLM_MODEL is set)
  const evalModel = (process.env.EVAL_MODEL || process.env.LLM_MODEL || "").trim();
  if (!evalModel) {
    console.error(
      "\n[Fatal Error] Neither EVAL_MODEL nor LLM_MODEL is set. Please set EVAL_MODEL or LLM_MODEL in .env.local.\n"
    );
    process.exit(1);
  }
  process.env.LLM_MODEL = evalModel;

  if (!options.allowFallback) {
    delete process.env.LLM_FALLBACK_MODELS;
  }

  // 2. Safety Guard (Verify target clinics and project host)
  const supabase = getAdminClient();
  let safety: { clinicAId: string; clinicBId: string; projectHost: string };
  try {
    safety = await runSafetyGuard(supabase, { yes: options.yes });
  } catch (err: any) {
    console.error(`\n${err.message}\n`);
    process.exit(1);
  }

  // 3. Relax Rate Limits for in-process evaluations
  process.env.RATE_LIMIT_RELAXED = "true";

  // 4. Capture Pre-run Database Row Counts
  const preCounts = await fetchDatabaseCounts(supabase);
  console.log(
    `[Baseline Counts] docs=${preCounts.documents} chunks=${preCounts.chunks} msgs=${preCounts.messages} convs=${preCounts.conversations} appts=${preCounts.appointments} patients=${preCounts.patients}`
  );

  // 5. Load and Filter Scenarios
  let scenarios = loadAllScenarios(scenariosDir);
  if (options.category) {
    scenarios = scenarios.filter(
      (s) => s.category.toLowerCase() === options.category!.toLowerCase()
    );
  }
  if (options.id) {
    scenarios = scenarios.filter((s) => s.id === options.id);
  }

  if (scenarios.length === 0) {
    console.error(
      `\n[Error] No scenarios matched filters: category=${options.category ?? "*"}, id=${options.id ?? "*"}\n`
    );
    process.exit(1);
  }

  console.log(`[Suite Loaded] ${scenarios.length} scenarios selected for execution.\n`);

  if (options.dryRun) {
    console.log("===============================================================================");
    console.log("                           DRY RUN EXECUTION PLAN                              ");
    console.log("===============================================================================");
    for (let i = 0; i < scenarios.length; i++) {
      const s = scenarios[i];
      const phone = `+9199999${String(i + 1).padStart(5, "0")}`;
      console.log(`\n[Plan ${i + 1}/${scenarios.length}] ${s.id} (${s.category})`);
      console.log(`  Description: ${s.description}`);
      console.log(`  Test Phone:  ${maskPhone(phone)}`);
      if (s.setup) {
        console.log(`  Setup:       ${JSON.stringify(s.setup)}`);
      }
      for (let t = 0; t < s.turns.length; t++) {
        const expanded = expandTemplate(s.turns[t].user, {
          patientPhone: phone,
          doctorAId: "demo-doc-a",
          clinicBAppointmentId: "demo-appt-b",
          now: DateTime.now().setZone("Asia/Kolkata"),
          timezone: "Asia/Kolkata",
        });
        console.log(`  Turn ${t + 1}:     "${expanded}"`);
        if (s.turns[t].expect) {
          console.log(`    Turn Expect: ${JSON.stringify(s.turns[t].expect)}`);
        }
      }
      if (s.expect) {
        console.log(`  Final Expect:  ${JSON.stringify(s.expect)}`);
      }
    }
    console.log("\n===============================================================================");
    console.log(`[Dry Run Completed] Validated ${scenarios.length} scenarios successfully.`);
    console.log("(0 API requests sent, 0 model tokens consumed, 0 DB rows written)");
    console.log("===============================================================================\n");
    process.exit(0);
  }

  const repeatCount = Math.max(1, options.repeat ?? 1);
  const scenarioSummaries: ScenarioSummary[] = [];

  // 6. Execute Scenarios
  for (let i = 0; i < scenarios.length; i++) {
    const scenario = scenarios[i];
    console.log(
      `[Scenario ${i + 1}/${scenarios.length}] ${scenario.id} (${scenario.category}) - ${scenario.description}`
    );

    const runs: ScenarioRunResult[] = [];
    for (let r = 1; r <= repeatCount; r++) {
      if (repeatCount > 1) {
        console.log(`  -> Run ${r}/${repeatCount}...`);
      }
      const runResult = await runScenario(
        scenario,
        i,
        r,
        supabase,
        safety.clinicAId,
        safety.clinicBId,
        options
      );
      runs.push(runResult);
    }

    const passedRuns = runs.filter((r) => r.status === "PASSED");
    const infraRuns = runs.filter((r) => r.status === "INFRA_ERROR");
    const failedRuns = runs.filter((r) => r.status === "FAILED");

    let status: ScenarioStatus = "FAILED";
    let isFlaky = false;

    if (passedRuns.length === repeatCount) {
      status = "PASSED";
    } else if (infraRuns.length === repeatCount) {
      status = "INFRA_ERROR";
    } else if (passedRuns.length > 0 && failedRuns.length > 0) {
      status = "FAILED";
      isFlaky = true;
    } else {
      status = "FAILED";
    }

    const firstFailed = runs.find((r) => r.status !== "PASSED");
    scenarioSummaries.push({
      scenarioId: scenario.id,
      category: scenario.category,
      allRunsPassed: status === "PASSED",
      runs,
      isFlaky,
      status,
      failedExpectation: firstFailed?.failedExpectation,
      failedReplyText: firstFailed?.failedReplyText,
    });

    console.log(`  -> Status: ${status}${isFlaky ? " (FLAKY)" : ""}`);
  }

  // 7. Verify Post-run Database Row Invariance
  const postCounts = await fetchDatabaseCounts(supabase);
  const countDiffs: string[] = [];
  for (const key of Object.keys(preCounts) as Array<keyof typeof preCounts>) {
    if (preCounts[key] !== postCounts[key]) {
      countDiffs.push(
        `${key}: pre=${preCounts[key]}, post=${postCounts[key]} (diff=${postCounts[key] - preCounts[key]})`
      );
    }
  }

  if (countDiffs.length > 0) {
    console.error(
      "\n" +
        "!".repeat(79) +
        "\n[LOUD WARNING: DATABASE ROW LEAK DETECTED!]\n" +
        "Row count invariant violated after eval suite execution:\n  " +
        countDiffs.join("\n  ") +
        "\n" +
        "!".repeat(79) +
        "\n"
    );
  } else {
    console.log(
      "\n[Database Invariant Verified] Clean teardown confirmed: all table row counts match baseline exactly."
    );
  }

  // 8. Aggregate Category Metrics
  const categories = Array.from(new Set(scenarios.map((s) => s.category)));
  const categorySummaries: CategorySummary[] = categories.map((cat) => {
    const catScenarios = scenarioSummaries.filter((s) => s.category === cat);
    const catRuns = catScenarios.flatMap((s) => s.runs);
    const total = catScenarios.length;
    const passed = catScenarios.filter((s) => s.status === "PASSED").length;
    const failed = catScenarios.filter((s) => s.status === "FAILED").length;
    const infraErrors = catScenarios.filter((s) => s.status === "INFRA_ERROR").length;
    const flaky = catScenarios.filter((s) => s.isFlaky).length;

    const totalLatency = catRuns.reduce((acc, r) => acc + r.totalLatencyMs, 0);
    const totalTokens = catRuns.reduce((acc, r) => acc + r.totalTokens, 0);

    return {
      category: cat,
      total,
      passed,
      failed,
      infraErrors,
      flaky,
      avgLatencyMs: catRuns.length > 0 ? Math.round(totalLatency / catRuns.length) : 0,
      avgTokens: catRuns.length > 0 ? Math.round(totalTokens / catRuns.length) : 0,
    };
  });

  const totalScenarios = scenarioSummaries.length;
  const passedScenarios = scenarioSummaries.filter((s) => s.status === "PASSED").length;
  const failedScenarios = scenarioSummaries.filter((s) => s.status === "FAILED").length;
  const infraErrorScenarios = scenarioSummaries.filter(
    (s) => s.status === "INFRA_ERROR"
  ).length;
  const flakyScenarios = scenarioSummaries.filter((s) => s.isFlaky).length;

  const evaluatedScenarios = totalScenarios - infraErrorScenarios;
  const passRate =
    evaluatedScenarios > 0 ? passedScenarios / evaluatedScenarios : 1.0;

  // 9. Compute Hashes and Metadata
  const gitSha = getGitSha();
  const systemPromptHash = crypto
    .createHash("sha256")
    .update(
      buildSystemPrompt({
        clinicName: "Demo Clinic A",
        timezone: "Asia/Kolkata",
      })
    )
    .digest("hex")
    .slice(0, 16);
  const scenarioFilesHash = computeScenarioFilesHash(scenariosDir);

  const report: EvalRunReport = {
    timestamp: new Date().toISOString(),
    gitSha,
    modelId: evalModel,
    systemPromptHash,
    scenarioFilesHash,
    totalScenarios,
    evaluatedScenarios,
    passedScenarios,
    failedScenarios,
    infraErrorScenarios,
    flakyScenarios,
    passRate,
    categorySummaries,
    scenarioSummaries,
  };

  // 10. Display Summary, Write JSON, and Record in DB
  printEvalSummaryTable(report);
  const { fullReportPath, summaryPath } = writeReportFiles(report);
  console.log(`[Reports Written]`);
  console.log(`  Full Report:    ${fullReportPath}`);
  console.log(`  Latest Summary: ${summaryPath}`);

  await insertEvalRunToDatabase(report, supabase);

  // Return exit status: 0 if all evaluated passed, 1 if any evaluated failed
  if (failedScenarios > 0) {
    process.exit(1);
  }
}

if (require.main === module || process.argv[1]?.endsWith("run.ts")) {
  main().catch((err) => {
    console.error("[Fatal Evals Runner Error]:", err);
    process.exit(1);
  });
}

