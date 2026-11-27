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
 * drug on this prescription match an allergy tag on the chart? Names are
 * compared word by word, so a strength or a salt does not hide a drug
 * (`Metronidazole 400 mg` still matches) and a longer word is not mistaken for
 * a shorter one (`allergy:sulfa` does not catch ferrous sulfate). It claims
 * only what the text says:
 *
 *   - a tag whose words are the drug's name, fall inside it, or end it:
 *     `penicillin` catches `Penicillin V (Phenoxymethylpenicillin)`,
 *     `metronidazole` catches `Metronidazole 400 mg`, `cortisone` catches
 *     `Hydrocortisone`;
 *   - a tag naming another name of the same drug or family, because the chart
 *     and the prescription rarely use the same one: `amoxicillin` catches
 *     `Augmentin`, `ibuprofen` catches `Brufen`, `metronidazole` catches
 *     `Flagyl`, `penicillin` catches amoxicillin.
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
 * Names that mean the same drug, or members of a family whose other members
 * are off the table too. A chart may carry any of them — generic, brand or the
 * family itself — and the prescription may carry any other, so every spelling
 * of the same risk lives in one group. Charts pluralise as readily as they
 * singularise (`NSAIDs`, `penicillins`), so the trailing s is folded away on
 * both sides and the table only ever lists one form.
 */
const DRUG_GROUPS: string[][] = [
  [
    "penicillin",
    "amoxicillin",
    "amoxycillin",
    "amoxiclav",
    "co-amoxiclav",
    "ampicillin",
    "flucloxacillin",
    "phenoxymethylpenicillin",
    "augmentin",
  ],
  ["cephalosporin", "cephalexin", "cefixime", "cefuroxime", "ceftriaxone", "cefadroxil", "keflex"],
  [
    "sulfonamide",
    "sulfa",
    "sulfa drugs",
    "sulfamethoxazole",
    "co-trimoxazole",
    "cotrimoxazole",
    "sulfasalazine",
    "sulfadiazine",
  ],
  [
    "nsaid",
    "ibuprofen",
    "diclofenac",
    "naproxen",
    "ketorolac",
    "mefenamic",
    "nimesulide",
    "piroxicam",
    "aspirin",
    "acetylsalicylic acid",
    "aceclofenac",
    "brufen",
    "nurofen",
    "advil",
    "voltaren",
    "cataflam",
    "ponstan",
  ],
  ["macrolide", "azithromycin", "erythromycin", "clarithromycin", "zithromax"],
  ["tetracycline", "doxycycline", "minocycline"],
  ["nitroimidazole", "metronidazole", "tinidazole", "ornidazole", "secnidazole", "flagyl"],
  ["quinolone", "ciprofloxacin", "levofloxacin", "ofloxacin", "norfloxacin"],
  ["paracetamol", "acetaminophen", "panadol", "tylenol", "calpol"],
  ["clindamycin", "dalacin"],
  ["fluconazole", "diflucan"],
  ["chlorhexidine", "corsodyl"],
  ["benzydamine", "difflam"],
  ["povidone iodine", "betadine"],
  ["triamcinolone", "kenalog"],
  ["lidocaine", "xylocaine"],
  ["acyclovir", "zovirax"],
];

/** `nsaids` and `nsaid` name the same thing; so do `penicillins`. */
function withoutPlural(word: string): string {
  return word.length > 4 && word.endsWith("s") && !word.endsWith("ss") ? word.slice(0, -1) : word;
}

/** Lowercase, punctuation to spaces, split into words — the form compared in. */
function wordsOf(...names: (string | null | undefined)[]): string[] {
  const words = new Set<string>();
  for (const name of names) {
    for (const word of (name ?? "")
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, " ")
      .trim()
      .split(" ")) {
      if (word) words.add(withoutPlural(word));
    }
  }
  return [...words];
}

/** A drug name, or a group of names that mean the same risk, as words. */
type NameWords = string[];
type NameGroup = NameWords[];

/** The groups, in the same word form. */
const GROUPS: NameGroup[] = DRUG_GROUPS.map((names) => names.map((name) => wordsOf(name)));

/** The groups a drug belongs to: any of their other names is the same risk. */
function groupsOf(drugWords: NameWords): NameGroup[] {
  return GROUPS.filter((group) => group.some((member) => sameName(member, drugWords)));
}

/**
 * Every word of `a` appears in `b`. One direction of the match: the allergy
 * `penicillin` is inside the drug's `["penicillin", "v"]`, and the drug
 * `["metronidazole", "400", "mg"]` contains the allergy `["metronidazole"]`.
 */
function contains(words: string[], other: string[]): boolean {
  return words.every((word) => other.includes(word));
}

/**
 * One word is the tail of another: `hydrocortisone` ends with `cortisone`,
 * `phenoxymethylpenicillin` with `penicillin`. Only from five letters up, so
 * short fragments cannot collide, and only at the end — a prefix rule would
 * make `allergy:sulfa` catch ferrous sulfate.
 */
function endsWithWord(a: string, b: string): boolean {
  const [shorter, longer] = a.length <= b.length ? [a, b] : [b, a];
  return shorter.length >= 5 && longer.endsWith(shorter);
}

/** Same name once the two are read as words, whichever side is longer. */
function sameName(a: string[], b: string[]): boolean {
  return contains(a, b) || contains(b, a) || a.some((x) => b.some((y) => endsWithWord(x, y)));
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

/** The tags as words, each name once however it is spelled on the chart. */
function allergiesOf(alerts: string | null | undefined): { raw: string; words: string[] }[] {
  const byName = new Map<string, { raw: string; words: string[] }>();
  for (const tag of allergyTags(alerts)) {
    const words = wordsOf(tag);
    const key = words.join(" ");
    if (words.length && !byName.has(key)) byName.set(key, { raw: tag, words });
  }
  return [...byName.values()];
}

/**
 * The drugs on a prescription whose name, or whose family, matches an
 * `allergy:` tag on the chart. Empty when there are no allergy tags at all.
 */
export function findAllergyConflicts(
  alerts: string | null | undefined,
  drugs: PrescribedDrug[],
): AllergyConflict[] {
  const allergies = allergiesOf(alerts);
  if (!allergies.length || !drugs.length) return [];

  const conflicts: AllergyConflict[] = [];
  const seen = new Set<string>();
  for (const drug of drugs) {
    const drugWords = wordsOf(drug.drug_name, drug.generic_name);
    if (!drugWords.length) continue;
    const groups = groupsOf(drugWords);
    for (const allergy of allergies) {
      const basis: ConflictBasis | null = sameName(drugWords, allergy.words)
        ? "name"
        : groups.some((group) => group.some((member) => sameName(member, allergy.words)))
          ? "class"
          : null;
      if (!basis) continue;

      const key = `${drug.drug_name.toLowerCase()}|${allergy.raw.toLowerCase()}`;
      if (seen.has(key)) continue;
      seen.add(key);
      conflicts.push({ drug: drug.drug_name, allergy: allergy.raw, basis });
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
