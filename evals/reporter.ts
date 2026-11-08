/**
 * evals/reporter.ts
 *
 * Formats evaluation reports for CLI display, writes artifact JSON files,
 * and records the evaluation run into the Supabase eval_runs table.
 *
 * Guarantees:
 * - Phone numbers are masked (only last 2 digits visible).
 * - Full JSON output written to evals/results/<timestamp>.json (gitignored).
 * - Counts-only summary written to evals/results/latest-summary.json (committed; no replies).
 * - eval_runs row inserted with service role (pass_rate excludes INFRA_ERROR from denominator).
 */

import fs from "fs";
import path from "path";
import { maskPhone } from "./template";
import {
  CategorySummary,
  EvalRunReport,
  LatestSummaryJSON,
  ScenarioSummary,
} from "./types";
import { SupabaseClient } from "@supabase/supabase-js";

export function printEvalSummaryTable(report: EvalRunReport): void {
  console.log("\n===============================================================================");
  console.log("                        CLINICDESK EVALUATION REPORT                           ");
  console.log("===============================================================================");
  console.log(`Git SHA:              ${report.gitSha}`);
  console.log(`Model ID:             ${report.modelId}`);
  console.log(`System Prompt Hash:   ${report.systemPromptHash}`);
  console.log(`Scenario Files Hash:  ${report.scenarioFilesHash}`);
  console.log(`Timestamp:            ${report.timestamp}`);
  console.log("-------------------------------------------------------------------------------");

  console.log(
    `Total Scenarios:      ${report.totalScenarios}`
  );
  console.log(
    `Evaluated Scenarios:  ${report.evaluatedScenarios} (excludes ${report.infraErrorScenarios} infra errors)`
  );
  console.log(
    `Passed Scenarios:     ${report.passedScenarios}`
  );
  console.log(
    `Failed Scenarios:     ${report.failedScenarios}`
  );
  console.log(
    `Infra Errors:         ${report.infraErrorScenarios}`
  );
  console.log(
    `Flaky Scenarios:      ${report.flakyScenarios}`
  );
  console.log(
    `Pass Rate:            ${(report.passRate * 100).toFixed(1)}% (${report.passedScenarios}/${report.evaluatedScenarios} evaluated)`
  );
  console.log("-------------------------------------------------------------------------------");

  // Category breakdown table
  console.log("\nCATEGORY BREAKDOWN:");
  console.log(
    "Category".padEnd(18) +
      "Total".padStart(8) +
      "Passed".padStart(8) +
      "InfraErr".padStart(10) +
      "Flaky".padStart(8) +
      "Avg Latency".padStart(14) +
      "Avg Tokens".padStart(12)
  );
  console.log("-".repeat(78));

  for (const cat of report.categorySummaries) {
    console.log(
      cat.category.padEnd(18) +
        String(cat.total).padStart(8) +
        String(cat.passed).padStart(8) +
        String(cat.infraErrors).padStart(10) +
        String(cat.flaky).padStart(8) +
        `${cat.avgLatencyMs}ms`.padStart(14) +
        String(cat.avgTokens).padStart(12)
    );
  }
  console.log("-".repeat(78));

  // Failure details
  const failedScenarios = report.scenarioSummaries.filter(
    (s) => s.status === "FAILED"
  );
  if (failedScenarios.length > 0) {
    console.log("\nFAILED SCENARIOS:");
    for (const failed of failedScenarios) {
      console.log(`\n[FAIL] Scenario: ${failed.scenarioId} (${failed.category})`);
      console.log(`  Reason: ${failed.failedExpectation || "Expectation failure"}`);
      if (failed.failedReplyText) {
        // Sanitize any accidental phone numbers in failed reply
        const sanitizedReply = failed.failedReplyText.replace(
          /(\+91\d{8})(\d{2})/g,
          (_match, p1, p2) => maskPhone(`+91${p1}${p2}`)
        );
        console.log(`  Reply:  "${sanitizedReply}"`);
      }
    }
  }

  const infraScenarios = report.scenarioSummaries.filter(
    (s) => s.status === "INFRA_ERROR"
  );
  if (infraScenarios.length > 0) {
    console.log("\nINFRASTRUCTURE ERRORS (Excluded from pass rate denominator):");
    for (const infra of infraScenarios) {
      console.log(`\n[INFRA_ERROR] Scenario: ${infra.scenarioId} (${infra.category})`);
      console.log(`  Reason: ${infra.failedExpectation || "Rate limit or busy timeout"}`);
    }
  }

  console.log("\n===============================================================================\n");
}

export function writeReportFiles(
  report: EvalRunReport,
  resultsDir = path.resolve(process.cwd(), "evals/results")
): { fullReportPath: string; summaryPath: string } {
  if (!fs.existsSync(resultsDir)) {
    fs.mkdirSync(resultsDir, { recursive: true });
  }

  // 1. Write full timestamped JSON report (gitignored)
  const safeTimestamp = report.timestamp.replace(/[:.]/g, "-");
  const fullReportPath = path.join(resultsDir, `${safeTimestamp}.json`);
  fs.writeFileSync(fullReportPath, JSON.stringify(report, null, 2), "utf-8");

  // 2. Write counts-only latest-summary.json (committed; no replies)
  const summaryJSON: LatestSummaryJSON = {
    timestamp: report.timestamp,
    git_sha: report.gitSha,
    model_id: report.modelId,
    system_prompt_hash: report.systemPromptHash,
    scenario_files_hash: report.scenarioFilesHash,
    total: report.totalScenarios,
    evaluated: report.evaluatedScenarios,
    passed: report.passedScenarios,
    failed: report.failedScenarios,
    infra_errors: report.infraErrorScenarios,
    flaky: report.flakyScenarios,
    pass_rate: parseFloat(report.passRate.toFixed(4)),
    categories: report.categorySummaries.map((c) => ({
      category: c.category,
      total: c.total,
      passed: c.passed,
      infra_errors: c.infraErrors,
      pass_rate:
        c.total - c.infraErrors > 0
          ? parseFloat((c.passed / (c.total - c.infraErrors)).toFixed(4))
          : 1.0,
    })),
  };

  const summaryPath = path.join(resultsDir, "latest-summary.json");
  fs.writeFileSync(summaryPath, JSON.stringify(summaryJSON, null, 2), "utf-8");

  return { fullReportPath, summaryPath };
}

export async function insertEvalRunToDatabase(
  report: EvalRunReport,
  supabase: SupabaseClient
): Promise<string | null> {
  try {
    const { data, error } = await supabase
      .from("eval_runs")
      .insert({
        git_sha: report.gitSha,
        pass_rate: report.passRate,
        total: report.evaluatedScenarios,
        passed: report.passedScenarios,
      })
      .select("id")
      .single();

    if (error) {
      console.error("[Reporter] Warning: Failed to insert eval_runs row:", error.message);
      return null;
    }

    return data?.id ?? null;
  } catch (err: any) {
    console.error("[Reporter] Warning: Failed to insert eval_runs row:", err?.message);
    return null;
  }
}

