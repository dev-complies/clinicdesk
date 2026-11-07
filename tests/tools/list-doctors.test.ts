import * as dotenv from "dotenv";
import path from "path";
import { beforeAll, describe, expect, it } from "vitest";
import { getAdminClient } from "../../src/lib/supabase/admin";
import { listDoctors } from "../../src/lib/tools/list-doctors";

dotenv.config({ path: path.resolve(process.cwd(), ".env.local") });

describe("Tool: list_doctors", () => {
  let clinicAId: string;
  let clinicBId: string;

  beforeAll(async () => {
    const supabase = getAdminClient();
    const { data: clinicA, error: errA } = await supabase
      .from("clinics")
      .select("id")
      .eq("name", "Demo Clinic A")
      .single();
    if (errA || !clinicA) throw new Error(`Failed to find Demo Clinic A: ${errA?.message}`);
    clinicAId = clinicA.id;

    const { data: clinicB, error: errB } = await supabase
      .from("clinics")
      .select("id")
      .eq("name", "Demo Clinic B")
      .single();
    if (errB || !clinicB) throw new Error(`Failed to find Demo Clinic B: ${errB?.message}`);
    clinicBId = clinicB.id;
  });

  it("returns only active doctors for the requested clinic", async () => {
    const result = await listDoctors(clinicAId);
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.length).toBeGreaterThanOrEqual(2);
    const doctorNames = result.data.map((d) => d.name);
    expect(doctorNames).toContain("Dr. Priya Sharma");
    expect(doctorNames).toContain("Dr. Rahul Mehta");
    // Must NOT contain Clinic B's doctor
    expect(doctorNames).not.toContain("Dr. Anjali Singh");

    for (const doc of result.data) {
      expect(doc).toHaveProperty("id");
      expect(doc).toHaveProperty("name");
      expect(doc).toHaveProperty("speciality");
      expect(typeof doc.fee).toBe("number");
    }
  });

  it("filters doctors by speciality (case-insensitive)", async () => {
    const result = await listDoctors(clinicAId, { speciality: "cardiology" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data.length).toBe(1);
    expect(result.data[0].name).toBe("Dr. Priya Sharma");
    expect(result.data[0].speciality).toBe("Cardiology");
  });

  it("returns empty list when no doctor matches the speciality", async () => {
    const result = await listDoctors(clinicAId, { speciality: "Pediatrics" });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    expect(result.data).toEqual([]);
  });

  it("returns INVALID_INPUT when clinicId is invalid", async () => {
    // @ts-expect-error testing invalid input
    const result = await listDoctors(null);
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.error).toBe("INVALID_INPUT");
  });
});

