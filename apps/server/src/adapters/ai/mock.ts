import type { PreCheckInput, PreCheckProvider } from '../../ports/index.js';

const DISCLAIMER =
  'Advisory output to support human review. It is not legal advice, does not decide whether information is inside or material, and never approves or blocks a release.';

const SIGNALS: Record<string, RegExp> = {
  inside_information: /acquisition|merger|takeover|profit warning|trading update|restructuring|resign|insolven|delist|material contract|regulatory (approval|investigation)|opk\u00f8b|fusion|nedjustering|opjustering|konkurs|afnotering/i,
  results: /full[- ]year|half[- ]year|interim|annual results|revenue|ebitda|earnings per share|net income|\u00e5rsrapport|halv\u00e5rsrapport|regnskab/i,
  pdmr_dealing: /pdmr|director dealing|purchase of shares|sale of shares|closely associated|transaction in own shares|ledende medarbejdere|n\u00e6rtst\u00e5ende/i,
  major_shareholding: /major shareholder|voting rights|crossed the .{0,12}threshold|flagging|st\u00f8rre aktion\u00e6r|stemmerettigheder/i,
  share_buyback: /buy-?back|repurchase|treasury shares|tilbagek\u00f8b|egne aktier/i,
  general_meeting: /general meeting|\bAGM\b|\bEGM\b|generalforsamling/i,
  form_8k: /8-k|item\s*\d\.\d{2}|earnings release|results of operations|regulation fd/i,
};
const PRICE_SENSITIVE = /profit warning|acquisition|merger|takeover|guidance|resign|insolven|delist|material contract|investigation|restatement|opk\u00f8b|fusion|nedjustering|opjustering|konkurs|afnotering/i;
const AUDIENCE = '(?:analyst|investor|shareholder|institutional)s?';
const EVENT = '(?:call|briefing|meeting|one-on-one|roadshow|conference|dinner)';
const SELECTIVE = new RegExp(`\\b${AUDIENCE}\\b.{0,60}\\b${EVENT}\\b|\\b${EVENT}\\b.{0,60}\\b${AUDIENCE}\\b`, 'i');
const LEAK = /rumou?r|leak|market speculation|press reports|rygter|l\u00e6kage/i;
const FORWARD_LOOKING = /\b(expect|anticipate|outlook|guidance|forecast|projected?|forventer|forventning)\b/i;
const CAUTION = /forward-looking|risks and uncertainties|safe harbou?r|fremadrettede udsagn|risici og usikkerhed/i;
const CONTACT = /enquiries|inquiries|contact|investor relations|henvendelser|kontakt/i;

const DANISH_WORDS = /\b(og|af|til|er|har|med|p\u00e5|den|det|som|ikke|selskabet|bestyrelsen)\b/gi;
const ENGLISH_WORDS = /\b(the|and|of|to|is|has|with|for|that|company|board)\b/gi;

/** The language the text really reads as, or null when it is too short or too mixed to tell. */
const languageOf = (text: string): 'da' | 'en' | null => {
  if (text.length < 120) return null;
  const da = text.match(DANISH_WORDS)?.length ?? 0;
  const en = text.match(ENGLISH_WORDS)?.length ?? 0;
  return da > en * 2 ? 'da' : en > da * 2 ? 'en' : null;
};

const snippet = (text: string, re: RegExp): string => {
  const m = re.exec(text);
  if (!m) return '';
  const start = Math.max(0, m.index - 40);
  return text.slice(start, m.index + m[0].length + 40).replace(/\s+/g, ' ').trim();
};

/**
 * Deterministic stand-in for an LLM: keyword evidence only. It exists so the whole product
 * (UI, storage, audit, tests) runs without a key and with reproducible output.
 */
export class MockPreCheckProvider implements PreCheckProvider {
  readonly name = 'mock-heuristic-v1';

  async analyze(input: PreCheckInput): Promise<unknown> {
    const text = `${input.headline}\n${input.body}`;
    const scored = input.categories
      .map((key) => ({ key, hits: SIGNALS[key] ? (text.match(new RegExp(SIGNALS[key]!.source, 'gi')) ?? []).length : 0 }))
      .sort((a, b) => b.hits - a.hits);
    const best = scored[0]?.hits ? scored[0] : undefined;
    const suggested = best?.key ?? (input.categories.includes('general') ? 'general' : input.category);

    const risks: {
      regime: 'UK_MAR' | 'EU_MAR' | 'US_REG_FD' | 'GENERAL';
      code: string;
      severity: 'low' | 'medium' | 'high';
      evidence: string;
      explanation: string;
      suggestedAction: string;
    }[] = [];

    const mar = input.jurisdiction === 'UK' ? ('UK_MAR' as const) : input.jurisdiction === 'DK' ? ('EU_MAR' as const) : null;
    if (mar && input.category !== 'inside_information' && PRICE_SENSITIVE.test(text)) {
      risks.push({
        regime: mar,
        code: `${mar}_POSSIBLE_INSIDE_INFORMATION`,
        severity: 'high',
        evidence: snippet(text, PRICE_SENSITIVE),
        explanation: 'The wording suggests information that could be inside information, but the category is not inside_information.',
        suggestedAction: 'Ask the company secretary to assess whether this is inside information. If disclosure is delayed, record the Art. 17(4) conditions.',
      });
    }
    if (mar && LEAK.test(text)) {
      risks.push({
        regime: mar,
        code: `${mar}_LEAK`,
        severity: 'medium',
        evidence: snippet(text, LEAK),
        explanation: 'A leak or rumour can mean confidentiality is lost, which removes the basis for delaying disclosure.',
        suggestedAction: 'Check whether a delay is still justified; if not, disclose as soon as possible.',
      });
    }
    const declared = input.metadata.language;
    const actual = languageOf(text);
    if (input.jurisdiction === 'DK' && actual && declared && actual !== declared) {
      risks.push({
        regime: 'GENERAL',
        code: 'DK_LANGUAGE_MISMATCH',
        severity: 'low',
        evidence: `metadata.language = ${String(declared)}; the text reads as ${actual === 'da' ? 'Danish' : 'English'}`,
        explanation: 'The language declared for the announcement does not match the language of the text, so the wrong statements may be attached on release.',
        suggestedAction: 'Fix the language field or the text before submitting.',
      });
    }
    if (input.jurisdiction === 'US' && SELECTIVE.test(text)) {
      risks.push({
        regime: 'US_REG_FD',
        code: 'US_REG_FD_SELECTIVE_DISCLOSURE',
        severity: 'medium',
        evidence: snippet(text, SELECTIVE),
        explanation: 'Communicating to analysts or investors before the public release risks selective disclosure under Regulation FD.',
        suggestedAction: 'Confirm the release is public before or at the same time as any briefing, or add Item 7.01.',
      });
    }
    const regFd = (input.metadata.regFd ?? {}) as { selectiveDisclosure?: string };
    if (input.jurisdiction === 'US' && regFd.selectiveDisclosure === 'unintentional') {
      risks.push({
        regime: 'US_REG_FD',
        code: 'US_REG_FD_PROMPT_DEADLINE',
        severity: 'high',
        evidence: 'regFd.selectiveDisclosure = unintentional',
        explanation: 'An unintentional selective disclosure was recorded; public disclosure must follow promptly.',
        suggestedAction: 'Check the Reg FD deadline shown on the announcement and release inside it.',
      });
    }
    if (FORWARD_LOOKING.test(text) && !CAUTION.test(text)) {
      risks.push({
        regime: 'GENERAL',
        code: 'FORWARD_LOOKING_WITHOUT_CAUTION',
        severity: 'low',
        evidence: snippet(text, FORWARD_LOOKING),
        explanation: 'Forward-looking wording appears without a cautionary statement.',
        suggestedAction: 'Add a forward-looking statements notice (safe-harbour language in the US).',
      });
    }

    const missing: { field: string; why: string }[] = [];
    if (input.body.trim().length < 200) {
      missing.push({ field: 'body', why: 'Very short: investors need enough detail to assess the information.' });
    }
    if (!CONTACT.test(text)) {
      missing.push({ field: 'contact details', why: 'No enquiries or investor relations contact is given.' });
    }
    if (FORWARD_LOOKING.test(text) && !CAUTION.test(text)) {
      missing.push({ field: 'forward-looking statement notice', why: 'Forward-looking wording needs a cautionary statement.' });
    }

    return {
      classification: {
        suggestedCategory: suggested,
        confidence: best ? Math.min(0.95, 0.4 + 0.15 * best.hits) : 0.3,
        rationale: best ? `Matched ${best.hits} ${best.key} signal(s) in the text.` : 'No category signals found; defaulted.',
      },
      missingInformation: missing,
      risks,
      humanReviewRequired: true,
      disclaimer: DISCLAIMER,
    };
  }
}
