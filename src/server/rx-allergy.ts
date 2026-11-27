/**
 * Drug–allergy checking for the prescription path.
 *
 * `patients.medical_alerts` is a comma-separated tag list and an allergy is
 * written `allergy:<name>` (see src/server/schema.sql and patient-import.ts).
 * The prescription screen already printed those tags, but nothing compared
 * them with the drugs being prescribed: an amoxicillin script could be saved
 * for a chart that says `allergy:penicillin`, with the warning sitting an inch
 * above it on the same page.
 *
 * This module answers the one question the prescription routes need — does a
 * drug on this prescription match an allergy tag on the chart? It claims only
 * what the text says:
 *
 *   - an allergy equal to (or contained in) a drug's name or a name it stands
 *     for: `penicillin` catches `Penicillin V (Phenoxymethylpenicillin)`,
 *     `amoxicillin` catches `Co-amoxiclav (Amoxicillin + Clavulanic acid)`;
 *   - an allergy that names a drug family the drug belongs to: `nsaid` catches
 *     naproxen, `penicillin` catches amoxicillin, `aspirin` catches ibuprofen.
 *
 * It deliberately does not infer cross-family cross-reactivity (penicillin →
 * cephalosporin is a clinical judgement, not a string match), and it ignores
 * the free-text conditions in the same field (`diabetes`, `anticoagulant`),
 * which are not allergies.
 */

export interface PrescribedDrug {
  drug_name: string;
  generic_name?: string | null;
}

export type ConflictBasis = "name" | "class";

export interface AllergyConflict {
  /** The drug as it was typed on the prescription. */
  drug: string;
  /** The allergy as the chart spells it, without the `allergy:` prefix. */
  allergy: string;
  /** `name` when the words match, `class` when only the family does. */
  basis: ConflictBasis;
}

/**
 * Families where a member allergy means the whole family is off the table.
 * Keys are the family names a chart is likely to carry; the members are the
 * drug names (and brand names) that belong to it.
 */
const CLASSES: Record<string, string[]> = {
  penicillin: [
    "penicillin",
    "amoxicillin",
    "amoxiclav",
    "co-amoxiclav",
    "ampicillin",
    "flucloxacillin",
    "phenoxymethylpenicillin",
    "augmentin",
  ],
  cephalosporin: ["cephalosporin", "cephalexin", "cefixime", "cefuroxime", "ceftriaxone", "cefadroxil", "keflex"],
  nsaid: [
    "nsaid",
    "nsaids",
    "ibuprofen",
    "diclofenac",
    "naproxen",
    "ketorolac",
    "mefenamic",
    "nimesulide",
    "piroxicam",
    "aspirin",
    "aceclofenac",
    "brufen",
    "voltaren",
    "ponstan",
  ],
  macrolide: ["macrolide", "azithromycin", "erythromycin", "clarithromycin", "zithromax"],
  tetracycline: ["tetracycline", "tetracyclines", "doxycycline", "minocycline"],
  nitroimidazole: ["nitroimidazole", "metronidazole", "tinidazole", "ornidazole", "secnidazole", "flagyl"],
  quinolone: ["quinolone", "ciprofloxacin", "levofloxacin", "ofloxacin", "norfloxacin"],
};

/**
 * Brand names and alternate spellings a chart may carry instead of the generic
 * name, keyed by the word as it appears in the prescription's drug name.
 */
const SYNONYMS: Record<string, string[]> = {
  augmentin: ["amoxicillin", "co-amoxiclav"],
  flagyl: ["metronidazole"],
  brufen: ["ibuprofen"],
  nurofen: ["ibuprofen"],
  advil: ["ibuprofen"],
  voltaren: ["diclofenac"],
  cataflam: ["diclofenac"],
  ponstan: ["mefenamic acid"],
  panadol: ["paracetamol", "acetaminophen"],
  tylenol: ["paracetamol", "acetaminophen"],
  calpol: ["paracetamol", "acetaminophen"],
  zithromax: ["azithromycin"],
  keflex: ["cephalexin"],
  dalacin: ["clindamycin"],
  diflucan: ["fluconazole"],
  corsodyl: ["chlorhexidine"],
  difflam: ["benzydamine"],
  betadine: ["povidone-iodine"],
  kenalog: ["triamcinolone"],
  xylocaine: ["lidocaine"],
  zovirax: ["acyclovir"],
};

/** Lowercase, punctuation to spaces, single spaces — the form we compare in. */
function words(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * The allergy names in a chart's alerts field. Only `allergy:` tags count:
 * everything else in the field is a condition, and matching "anticoagulant"
 * against a drug name would be noise, not safety.
 */
export function allergyTags(alerts: string | null | undefined): string[] {
  const tags: string[] = [];
  for (const raw of (alerts ?? "").split(",")) {
    const match = /^(?:drug\s+)?allergy\s*:\s*(.+)$/i.exec(raw.trim());
    const name = match?.[1]?.trim();
    if (name) tags.push(name);
  }
  return tags;
}

/** Every name the prescribed drug may be known by, normalized. */
function termsOf(drug: PrescribedDrug): Set<string> {
  const terms = new Set<string>();
  for (const raw of [drug.drug_name, drug.generic_name ?? ""]) {
    if (!raw) continue;
    // "Co-amoxiclav (Amoxicillin + Clavulanic acid)" is three names, and a
    // chart may carry any of them.
    for (const part of raw.split(/[(),+/]|\band\b/i)) {
      const term = words(part);
      if (!term) continue;
      terms.add(term);
      for (const [brand, generics] of Object.entries(SYNONYMS)) {
        if (!term.split(" ").includes(brand)) continue;
        for (const generic of generics) terms.add(words(generic));
      }
    }
  }
  return terms;
}

/** The families one of those names belongs to. */
function classesFor(terms: Set<string>): string[] {
  const found: string[] = [];
  for (const [family, members] of Object.entries(CLASSES)) {
    if (members.some((member) => [...terms].some((term) => term === member || (member.length >= 5 && term.includes(member))))) {
      found.push(family);
    }
  }
  return found;
}

/**
 * The drugs on a prescription whose name, or whose family, matches an
 * `allergy:` tag on the chart. Empty when there are no allergy tags at all.
 */
export function findAllergyConflicts(
  alerts: string | null | undefined,
  drugs: PrescribedDrug[],
): AllergyConflict[] {
  const allergies = allergyTags(alerts);
  if (!allergies.length || !drugs.length) return [];

  const conflicts: AllergyConflict[] = [];
  const seen = new Set<string>();
  for (const drug of drugs) {
    const terms = termsOf(drug);
    if (!terms.size) continue;
    const families = classesFor(terms);
    for (const allergy of allergies) {
      const wanted = words(allergy);
      if (!wanted) continue;

      let basis: ConflictBasis | null = null;
      for (const term of terms) {
        if (term === wanted || (wanted.length >= 4 && term.includes(wanted)) || (term.length >= 5 && wanted.includes(term))) {
          basis = "name";
          break;
        }
      }
      if (!basis) {
        for (const family of families) {
          const members = CLASSES[family] ?? [];
          if (members.some((member) => member === wanted || (member.length >= 4 && wanted.includes(member)))) {
            basis = "class";
            break;
          }
        }
      }
      if (!basis) continue;

      const key = `${drug.drug_name.toLowerCase()}|${allergy.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      conflicts.push({ drug: drug.drug_name, allergy, basis });
    }
  }
  return conflicts;
}

/** What a refused prescription tells the person at the desk or the chair. */
export function allergyConflictMessage(conflicts: AllergyConflict[]): string {
  if (!conflicts.length) return "";
  const [first] = conflicts;
  if (!first) return "";
  if (conflicts.length === 1) {
    const family = first.basis === "class" ? ` (same drug family, ${first.allergy})` : "";
    return `Allergy conflict: ${first.drug} matches this patient's ${first.allergy} allergy${family}. Nothing was saved — change the drug, or correct the patient's allergy list in their chart if it is out of date, then prescribe again.`;
  }
  const list = conflicts.map((c) => `${c.drug} (${c.allergy})`).join("; ");
  return `Allergy conflict: these drugs match this patient's allergy record: ${list}. Nothing was saved — change the drugs, or correct the patient's allergy list in their chart if it is out of date, then prescribe again.`;
}
