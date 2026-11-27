import { describe, expect, it } from "vitest";
import {
  allergyConflictMessage,
  allergyTags,
  findAllergyConflicts,
} from "../src/server/rx-allergy";

/**
 * The chart's `allergy:` tags used to be printed on the prescription and
 * nothing more. These pin down what "matches" means: the drug's own name, a
 * name it stands for, or a family a chart is likely to name.
 */

describe("reading allergy tags", () => {
  it("takes only allergy: tags, and ignores the conditions beside them", () => {
    expect(allergyTags("allergy:penicillin,allergy:latex")).toEqual(["penicillin", "latex"]);
    expect(allergyTags("allergy: penicillin, diabetes, anticoagulant")).toEqual(["penicillin"]);
    expect(allergyTags("penicillin")).toEqual([]);
    expect(allergyTags(null)).toEqual([]);
    expect(allergyTags("")).toEqual([]);
  });

  it("accepts the spacing and casing an imported chart produces", () => {
    expect(allergyTags("Allergy:Penicillin,ALLERGY: latex")).toEqual(["Penicillin", "latex"]);
    expect(allergyTags("drug allergy: sulfa-drugs")).toEqual(["sulfa-drugs"]);
  });
});

describe("a drug against the chart's allergies", () => {
  const amox = { drug_name: "Amoxicillin" };

  it("catches the drug named on the chart, through its family", () => {
    const conflicts = findAllergyConflicts("allergy:penicillin", [amox]);
    expect(conflicts).toEqual([{ drug: "Amoxicillin", allergy: "penicillin", basis: "class" }]);
  });

  it("catches a name inside a longer drug name", () => {
    const conflicts = findAllergyConflicts("allergy:penicillin", [
      { drug_name: "Penicillin V (Phenoxymethylpenicillin)" },
    ]);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]?.basis).toBe("name");

    // The combination product carries amoxicillin as one of its ingredients.
    expect(
      findAllergyConflicts("allergy:amoxicillin", [
        { drug_name: "Co-amoxiclav (Amoxicillin + Clavulanic acid)" },
      ]),
    ).toHaveLength(1);
  });

  it("matches the generic name recorded on the row", () => {
    expect(
      findAllergyConflicts("allergy:ibuprofen", [{ drug_name: "Brufen", generic_name: "Ibuprofen" }]),
    ).toHaveLength(1);
  });

  it("expands brand names to the drug they contain", () => {
    expect(findAllergyConflicts("allergy:amoxicillin", [{ drug_name: "Augmentin 625" }])).toHaveLength(1);
    expect(findAllergyConflicts("allergy:metronidazole", [{ drug_name: "Flagyl" }])).toHaveLength(1);
  });

  it("treats a family allergy as covering the family", () => {
    for (const drug_name of ["Ibuprofen", "Naproxen", "Diclofenac Potassium", "Ketorolac"]) {
      const conflicts = findAllergyConflicts("allergy:nsaid", [{ drug_name }]);
      expect(conflicts, drug_name).toHaveLength(1);
      expect(conflicts[0]?.basis).toBe("class");
    }
  });

  it("catches an allergy written with a reaction after it", () => {
    // The importer turns "Allergic to penicillin (rash)" into this tag.
    expect(findAllergyConflicts("allergy:penicillin-rash", [amox])).toHaveLength(1);
  });

  it("leaves unrelated drugs, other families and empty charts alone", () => {
    expect(findAllergyConflicts("allergy:penicillin", [{ drug_name: "Ibuprofen" }])).toEqual([]);
    expect(findAllergyConflicts("allergy:penicillin", [{ drug_name: "Cephalexin" }])).toEqual([]);
    expect(findAllergyConflicts("allergy:latex", [{ drug_name: "Amoxicillin" }])).toEqual([]);
    expect(findAllergyConflicts("diabetes,anticoagulant", [{ drug_name: "Amoxicillin" }])).toEqual([]);
    expect(findAllergyConflicts(null, [amox])).toEqual([]);
    expect(findAllergyConflicts("allergy:penicillin", [])).toEqual([]);
  });

  it("names each drug once however many times the tag is written", () => {
    expect(
      findAllergyConflicts("allergy:penicillin, allergy:Penicillin", [
        amox,
        { drug_name: "Amoxicillin" },
      ]),
    ).toHaveLength(1);
  });

  // Matching is word by word. That has to hold at the edges: a salt is not
  // the family, a strength does not hide the drug, and a shared word is not a
  // shared risk.
  it("does not read a sulfa tag as any sulfate salt", () => {
    expect(findAllergyConflicts("allergy:sulfa", [{ drug_name: "Ferrous sulfate" }])).toEqual([]);
  });

  it("matches the sulfa tag an imported chart carries to a sulfonamide", () => {
    // patient-import.ts writes "Allergic to sulfa drugs" as allergy:sulfa-drugs.
    expect(findAllergyConflicts("allergy:sulfa-drugs", [{ drug_name: "Co-trimoxazole" }])).toHaveLength(1);
    expect(findAllergyConflicts("allergy:sulfonamide", [{ drug_name: "Sulfamethoxazole" }])).toHaveLength(1);
  });

  it("reads through the strength a dragged-in drug name carries", () => {
    expect(findAllergyConflicts("allergy:metronidazole", [{ drug_name: "Metronidazole 400 mg" }])).toEqual([
      { drug: "Metronidazole 400 mg", allergy: "metronidazole", basis: "name" },
    ]);
  });

  it("reads a chart's plural the way it reads the singular", () => {
    expect(findAllergyConflicts("allergy:NSAIDs", [{ drug_name: "Ibuprofen" }])).toHaveLength(1);
  });

  it("accepts the other spelling of amoxicillin", () => {
    expect(findAllergyConflicts("allergy:amoxycillin", [{ drug_name: "Amoxicillin" }])).toHaveLength(1);
  });

  it("catches an allergy that is the tail of the drug's name", () => {
    expect(findAllergyConflicts("allergy:cortisone", [{ drug_name: "Hydrocortisone" }])).toHaveLength(1);
  });

  it("does not turn one shared word into a match", () => {
    // "acid" is in both names; neither name is the other.
    expect(findAllergyConflicts("allergy:folic acid", [{ drug_name: "Acetylsalicylic acid" }])).toEqual([]);
  });

  it("reports a conflict for every drug that has one", () => {
    const conflicts = findAllergyConflicts("allergy:penicillin,allergy:nsaid", [
      amox,
      { drug_name: "Ibuprofen" },
      { drug_name: "Chlorhexidine gluconate 0.2% mouthwash" },
    ]);
    expect(conflicts.map((c) => c.drug)).toEqual(["Amoxicillin", "Ibuprofen"]);
  });
});

describe("what the refused prescription says", () => {
  it("names the drug, the allergy and the way out", () => {
    const message = allergyConflictMessage([
      { drug: "Amoxicillin", allergy: "penicillin", basis: "class" },
    ]);
    expect(message).toContain("Amoxicillin");
    expect(message).toContain("penicillin");
    expect(message).toContain("same drug family");
    expect(message).toContain("Nothing was saved");
  });

  it("lists every conflict at once", () => {
    const message = allergyConflictMessage([
      { drug: "Amoxicillin", allergy: "penicillin", basis: "class" },
      { drug: "Ibuprofen", allergy: "nsaid", basis: "class" },
    ]);
    expect(message).toContain("Amoxicillin (penicillin)");
    expect(message).toContain("Ibuprofen (nsaid)");
  });

  it("is empty when there is nothing to say", () => {
    expect(allergyConflictMessage([])).toBe("");
  });
});
