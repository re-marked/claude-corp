/**
 * Feedback detector — pattern-matches founder messages for corrections
 * and confirmations. The router calls this on every founder→agent
 * dispatch; on a match it stamps `.pending-feedback.md` in the agent's
 * workspace. Dreams later consume the file, interpret severity + tone
 * in context, and promote the feedback to BRAIN.
 *
 * Design principles:
 * - Capture, not interpret. The router's job is to notice the moment.
 *   Severity and nuance judgment happens during dreams where the full
 *   context + founder's voice are understood.
 * - Wide net, low stakes on misses. Better to catch 70% with a few
 *   false positives than miss everything. Dreams sort it out.
 * - Polarity hint only: "looks like correction" / "looks like confirmation"
 *   / "both signals present" → dreams make the final call from the quote.
 *
 * Pattern lists are intentionally exhaustive and colloquial — Mark's
 * voice includes "bro", "bruh", "bussin", "lmao". Generic sentiment
 * lists from NLP libraries don't cover it. These patterns do.
 */

export type FeedbackPolarity = 'correction' | 'confirmation' | 'mixed';

export interface FeedbackMatch {
  polarity: FeedbackPolarity;
  /** Names of patterns that matched (for debugging + dream hints) */
  matchedPatterns: string[];
  /** The actual substrings that matched */
  matchedText: string[];
}

interface Pattern {
  name: string;
  re: RegExp;
}

// ── Correction patterns (negative polarity) ────────────────────────
//
// Word boundaries are mandatory. Case-insensitive. Each pattern is
// named so dreams can see which signals fired without re-running the
// regex engine.

const CORRECTION_PATTERNS: Pattern[] = [
  // Direct negation — the backbone
  { name: 'dont', re: /\b(don't|do not|dont)\b/i },
  { name: 'stop', re: /\b(stop|quit|cut it out|knock it off)\b/i },
  { name: 'no', re: /\b(no|nope|nah|naw|nu-uh|negative)\b/i },
  { name: 'never', re: /\bnever\b/i },
  { name: 'not', re: /\b(not|isn't|isnt|aren't|arent|wasn't|wasnt|weren't|werent)\b/i },
  { name: 'cannot', re: /\b(cannot|can't|cant|couldn't|couldnt)\b/i },
  { name: 'wont', re: /\b(won't|wont|wouldn't|wouldnt|shouldn't|shouldnt)\b/i },
  { name: 'doesnt', re: /\b(doesn't|doesnt|didn't|didnt)\b/i },

  // Explicit wrongness
  { name: 'wrong', re: /\bwrong\b/i },
  { name: 'incorrect', re: /\bincorrect\b/i },
  { name: 'thats-not', re: /\b(that's not|thats not|that isn't|that isnt|this isn't|this isnt)\b/i },
  { name: 'not-what-asked', re: /\bnot (what|how) (i|we|mark) (asked|wanted|meant|said|need|needed)\b/i },
  { name: 'missed-point', re: /\bmissed (the )?point\b/i },
  { name: 'off-mark', re: /\boff (the )?mark\b/i },
  { name: 'messed-up', re: /\bmessed up\b/i },
  { name: 'screwed-up', re: /\bscrewed up\b/i },
  { name: 'broken', re: /\bthis (is broken|doesn't work|doesnt work)\b/i },

  // Redirective — "not X, (rather|instead) Y"
  { name: 'actually', re: /\bactually\b/i },
  { name: 'instead', re: /\binstead\b/i },
  { name: 'rather', re: /\brather\b/i },
  { name: 'prefer-frame', re: /\bi('d| would) (prefer|rather|like|want|much)\b/i },
  { name: 'prefer', re: /\bprefer\b/i },
  { name: 'not-but', re: /\bnot [a-z ]+ but\b/i },
  { name: 'other-way', re: /\bother way\b/i },
  { name: 'opposite', re: /\bthe opposite\b/i },

  // Frustration / emphasis
  { name: 'bro-no', re: /\bbro,?\s+(no|why|wtf|come on|stop|please)\b/i },
  { name: 'bruh', re: /\bbruh\b/i },
  { name: 'wtf', re: /\bwtf\b/i },
  { name: 'what-the', re: /\bwhat the\b/i },
  { name: 'come-on', re: /\bcome on\b/i },
  { name: 'seriously', re: /\bseriously\b/i },
  { name: 'really-q', re: /\breally\?/i },
  { name: 'you-serious', re: /\b(are )?you serious\b/i },
  { name: 'youre-kidding', re: /\byou('re| are) kidding\b/i },
  { name: 'jeez', re: /\b(jeez|geez)\b/i },
  { name: 'ffs', re: /\bffs\b/i },
  { name: 'man', re: /\b(come on|oh) man\b/i },
  { name: 'ugh', re: /\bugh\b/i },
  { name: 'eww', re: /\b(eww|ew|yuck)\b/i },

  // Backward reference — "I told you"
  { name: 'i-told-you', re: /\bi (told|said) you\b/i },
  { name: 'i-literally-said', re: /\bi (literally |just )?(said|told)\b/i },
  { name: 'didnt-i-say', re: /\bdidn't i (say|tell|mention)\b/i },
  { name: 'already-said', re: /\b(i|we) already (said|told|mentioned)\b/i },
  { name: 'as-i-said', re: /\bas i (said|mentioned|told)\b/i },
  { name: 'asked-already', re: /\b(i|we) asked (already|you|for)\b/i },

  // Disappointment / re-ask
  { name: 'thats-not-what', re: /\bthat's not what (i|we|mark)\b/i },
  { name: 'why-did-you', re: /\bwhy (did|are|do|would) you\b/i },
  { name: 'you-forgot', re: /\byou forgot\b/i },
  { name: 'you-missed', re: /\byou (missed|skipped|ignored)\b/i },
  { name: 'didnt-do', re: /\bdidn't (do|read|check|look|see)\b/i },
  { name: 'you-keep', re: /\byou keep (doing|saying|writing|trying)\b/i },

  // Meta corrections — "read again"
  { name: 'read-again', re: /\bread (again|it again|my message|more carefully)\b/i },
  { name: 'go-back', re: /\bgo back (to|and)\b/i },
  { name: 'look-again', re: /\blook (at it again|again|more carefully)\b/i },
  { name: 'pay-attention', re: /\bpay attention\b/i },

  // Tone / style — too X, less X, simpler
  { name: 'too-x', re: /\btoo (long|verbose|much|many|short|dense|wordy|formal|casual|fast|slow)\b/i },
  { name: 'way-too', re: /\bway too\b/i },
  { name: 'make-it', re: /\bmake it (shorter|cleaner|simpler|tighter|less)\b/i },
  { name: 'simpler', re: /\bsimpler\b/i },
  { name: 'shorter', re: /\bshorter\b/i },
  { name: 'tighter', re: /\btighter\b/i },
  { name: 'just-do', re: /\bjust (do|say|write|ship)\b/i },
  { name: 'keep-it-short', re: /\bkeep it (simple|short|brief|tight)\b/i },
  { name: 'less-of', re: /\bless (of )?(the |that )?\b(verbose|padding|explanation|preamble)\b/i },

  // Negative emphasis
  { name: 'bad', re: /\b(bad|terrible|awful|garbage|trash|ugly|messy|gross|janky)\b/i },
  { name: 'boring', re: /\b(boring|bland|meh)\b/i },
  { name: 'weird', re: /\b(weird|odd|strange) (choice|approach|way|call)\b/i },

  // Rejection
  { name: 'rejected', re: /\brejected\b/i },
  { name: 'not-gonna', re: /\bnot (gonna|going to)\b/i },
  { name: 'hard-pass', re: /\bhard pass\b/i },
  { name: 'kill-it', re: /\b(kill|scrap|drop) (it|this|that)\b/i },

  // Redo signals
  { name: 'redo', re: /\b(re)?do (it|this|that) (again|over)?\b/i },
  { name: 'try-again', re: /\btry (again|it again|once more)\b/i },
  { name: 'fix-it', re: /\bfix (it|this|that)\b/i },
  { name: 'revert', re: /\brevert\b/i },
  { name: 'undo', re: /\bundo\b/i },
  { name: 'rollback', re: /\brollback\b/i },
  { name: 'start-over', re: /\bstart over\b/i },
  { name: 'throw-away', re: /\bthrow (it )?away\b/i },

  // Questioning authority / credibility
  { name: 'why-would-you', re: /\bwhy would you\b/i },
  { name: 'who-told-you', re: /\bwho told you\b/i },
  { name: 'where-did-you-get', re: /\bwhere did you get\b/i },
  { name: 'who-said', re: /\bwho (said|asked|told)\b/i },

  // Comparative disappointment — "close but no"
  { name: 'not-quite', re: /\bnot quite\b/i },
  { name: 'close-but', re: /\bclose but\b/i },
  { name: 'almost-but', re: /\balmost but\b/i },
  { name: 'not-exactly', re: /\bnot (exactly|really|totally)\b/i },
  { name: 'kinda-off', re: /\b(kinda|kind of|sorta) off\b/i },

  // Request to change
  { name: 'change-it', re: /\bchange (it|this|that)\b/i },
  { name: 'update-it', re: /\bupdate (it|this|that)\b/i },
  { name: 'revise', re: /\brevise\b/i },
  { name: 'rewrite', re: /\brewrite\b/i },
  { name: 'refactor-it', re: /\brefactor (it|this|that)\b/i },

  // Question-framed corrections — tone carries the sting
  { name: 'how-about-not', re: /\bhow about (not|don't|you don't)\b/i },
  { name: 'why-didnt', re: /\bwhy (didn't|don't) you\b/i },
  { name: 'can-you-not', re: /\bcan you not\b/i },
  { name: 'can-you-stop', re: /\bcan you stop\b/i },

  // Strong objection
  { name: 'hell-no', re: /\b(hell|heck) no\b/i },
  { name: 'hell-nah', re: /\b(hell|heck) nah\b/i },
  { name: 'i-hate', re: /\bi hate\b/i },
  { name: 'dislike', re: /\bdislike\b/i },

  // Apologetic / sandwich corrections
  { name: 'sorry-but', re: /\bsorry but\b/i },
  { name: 'no-offense', re: /\bno offense but\b/i },

  // Skepticism
  { name: 'hmm-not', re: /\bhmm,?\s+(not|no|that|this)\b/i },
  { name: 'uhh', re: /\buhh+\b/i },
  { name: 'hmmm', re: /\bhmm+\b(?!\s+(yes|ok|good))/i },

  // Specific request to remove/undo
  { name: 'remove-it', re: /\bremove (it|this|that)\b/i },
  { name: 'delete-it', re: /\bdelete (it|this|that)\b/i },
  { name: 'get-rid-of', re: /\bget rid of\b/i },
  { name: 'take-out', re: /\btake (it|this|that) out\b/i },

  // Meta — "you're missing"
  { name: 'youre-missing', re: /\byou('re| are) missing\b/i },
  { name: 'you-dont-get', re: /\byou don't get\b/i },
  { name: 'you-dont-understand', re: /\byou don't understand\b/i },

  // Specific negative reactions
  { name: 'no-thanks', re: /\bno thanks\b/i },
  { name: 'forget-it', re: /\bforget (it|that)\b/i },
  { name: 'nevermind', re: /\b(never mind|nevermind|nvm)\b/i },
  { name: 'not-like-that', re: /\bnot (like that|this way|like this)\b/i },
];

// ── Confirmation patterns (positive polarity) ──────────────────────

const CONFIRMATION_PATTERNS: Pattern[] = [
  // Compound positives that should beat single-word negatives —
  // listed FIRST so they win tiebreaks (e.g., "not bad" → positive,
  // not negative from "not")
  { name: 'not-bad', re: /\bnot bad\b/i },
  { name: 'no-problem', re: /\bno problem\b/i },
  { name: 'no-worries', re: /\bno worries\b/i },
  { name: 'no-doubt', re: /\bno doubt\b/i },

  // Affirmation — the backbone
  { name: 'yes', re: /\byes\b/i },
  { name: 'yeah', re: /\byeah\b/i },
  { name: 'yep', re: /\byep\b/i },
  { name: 'yup', re: /\byup\b/i },
  { name: 'ya', re: /\bya\b/i },
  { name: 'mhm', re: /\bmhm\b/i },
  { name: 'uh-huh', re: /\buh[- ]huh\b/i },
  { name: 'aight', re: /\baight\b/i },

  // Correctness
  { name: 'correct', re: /\bcorrect\b/i },
  { name: 'exactly', re: /\bexactly\b/i },
  { name: 'precisely', re: /\bprecisely\b/i },
  { name: 'thats-it', re: /\b(that's|thats) it\b/i },
  { name: 'thats-right', re: /\b(that's|thats) right\b/i },
  { name: 'youre-right', re: /\byou('re| are) right\b/i },
  { name: 'bingo', re: /\bbingo\b/i },
  { name: 'spot-on', re: /\bspot on\b/i },
  { name: 'on-point', re: /\bon point\b/i },
  { name: 'on-the-money', re: /\bon the money\b/i },

  // Praise
  { name: 'perfect', re: /\bperfect(ly)?\b/i },
  { name: 'great', re: /\bgreat\b/i },
  { name: 'wonderful', re: /\bwonderful\b/i },
  { name: 'amazing', re: /\bamazing\b/i },
  { name: 'incredible', re: /\bincredible\b/i },
  { name: 'outstanding', re: /\boutstanding\b/i },
  { name: 'love-it', re: /\blove (it|this|that)\b/i },
  { name: 'loving', re: /\bloving\b/i },
  { name: 'beautiful', re: /\bbeautiful\b/i },
  { name: 'clean', re: /\bclean (work|code|output|answer|response)?\b/i },
  { name: 'nice', re: /\bnice\b/i },
  { name: 'sick', re: /\b(sick|dope|fire|bussin|slay|slaps)\b/i },
  { name: 'chefs-kiss', re: /\bchef'?s kiss\b/i },
  { name: 'epic', re: /\bepic\b/i },
  { name: 'excellent', re: /\bexcellent\b/i },
  { name: 'brilliant', re: /\bbrilliant\b/i },
  { name: 'gorgeous', re: /\bgorgeous\b/i },

  // Approval
  { name: 'approved', re: /\bapproved\b/i },
  { name: 'ship-it', re: /\bship (it|that)\b/i },
  { name: 'lets-ship', re: /\blet('s| us) ship\b/i },
  { name: 'do-it', re: /\bdo it\b/i },
  { name: 'go-for-it', re: /\bgo for it\b/i },
  { name: 'good-to-go', re: /\bgood to go\b/i },
  { name: 'lgtm', re: /\blgtm\b/i },
  { name: 'looks-good', re: /\blooks good\b/i },
  { name: 'works-for-me', re: /\bworks for me\b/i },
  { name: 'wfm', re: /\bwfm\b/i },
  { name: 'green-light', re: /\bgreen light\b/i },
  { name: 'proceed', re: /\bproceed\b/i },
  { name: 'carry-on', re: /\bcarry on\b/i },
  { name: 'go-ahead', re: /\bgo ahead\b/i },

  // Validation — "good catch"
  { name: 'good-call', re: /\bgood call\b/i },
  { name: 'good-catch', re: /\bgood catch\b/i },
  { name: 'good-move', re: /\bgood move\b/i },
  { name: 'good-point', re: /\bgood point\b/i },
  { name: 'good-idea', re: /\bgood idea\b/i },
  { name: 'good-question', re: /\bgood question\b/i },
  { name: 'good-work', re: /\bgood work\b/i },
  { name: 'good-job', re: /\bgood job\b/i },
  { name: 'nice-work', re: /\bnice work\b/i },
  { name: 'well-done', re: /\bwell done\b/i },
  { name: 'fair-enough', re: /\bfair enough\b/i },
  { name: 'fair', re: /\bfair\b/i },
  { name: 'valid', re: /\bvalid\b/i },
  { name: 'true', re: /\btrue\b/i },
  { name: 'facts', re: /\bfacts\b/i },
  { name: 'hundred-percent', re: /\b100%\b/i },
  { name: 'absolutely', re: /\babsolutely\b/i },
  { name: 'definitely', re: /\bdefinitely\b/i },
  { name: 'for-sure', re: /\bfor sure\b/i },

  // Enthusiasm
  { name: 'omg', re: /\bomg\b/i },
  { name: 'oh-my', re: /\boh my (god|gosh)?\b/i },
  { name: 'wow', re: /\bwow\b/i },
  { name: 'whoa', re: /\bwhoa\b/i },
  { name: 'bro-yes', re: /\bbro,?\s+(yes|yeah|exactly|love|nice)\b/i },
  { name: 'lets-go', re: /\blet('s| us) go+\b/i },
  { name: 'lets-goo', re: /\bletsgoo+\b/i },
  { name: 'thats-what', re: /\b(that's|thats) what (i|i was)\b/i },
  { name: 'finally', re: /\bfinally\b/i },
  { name: 'about-time', re: /\b(about|bout) time\b/i },
  { name: 'hell-yeah', re: /\b(hell|heck) yeah\b/i },
  { name: 'big-yes', re: /\bbig yes\b/i },

  // Preservation — "keep going"
  { name: 'keep-doing', re: /\bkeep (doing|going|that|this|up)\b/i },
  { name: 'more-of-this', re: /\bmore of (this|that)\b/i },
  { name: 'this-is-the-way', re: /\bthis is the way\b/i },
  { name: 'stick-with', re: /\bstick with (it|that|this)\b/i },

  // Trust signals
  { name: 'your-call', re: /\byour call\b/i },
  { name: 'up-to-you', re: /\bup to you\b/i },
  { name: 'i-trust-you', re: /\bi trust you\b/i },
  { name: 'good-instinct', re: /\bgood (instinct|instincts|judgment|taste)\b/i },
  { name: 'you-know-best', re: /\byou know best\b/i },

  // Meta — "you got it"
  { name: 'you-got-it', re: /\byou got it\b/i },
  { name: 'you-nailed', re: /\byou nailed\b/i },
  { name: 'nailed-it', re: /\bnailed it\b/i },
  { name: 'solid', re: /\bsolid\b/i },
  { name: 'clean-work', re: /\bclean work\b/i },

  // Appreciation
  { name: 'thanks', re: /\b(thanks|thank you|thx|ty)\b/i },
  { name: 'appreciate', re: /\bappreciate\b/i },
  { name: 'grateful', re: /\bgrateful\b/i },

  // Agreement
  { name: 'totally', re: /\btotally\b/i },
  { name: 'agree', re: /\b(agreed|i agree|agree)\b/i },
  { name: 'same', re: /\b(same|same here)\b/i },
  { name: 'word', re: /\bword\b/i },

  // Progress signals — "that's better"
  { name: 'thats-better', re: /\b(that's|thats) better\b/i },
  { name: 'much-better', re: /\bmuch better\b/i },
  { name: 'way-better', re: /\bway better\b/i },
  { name: 'improvement', re: /\bimprovement\b/i },
  { name: 'getting-there', re: /\bgetting there\b/i },

  // Casual positive
  { name: 'tight', re: /\btight\b/i },
  { name: 'smooth', re: /\bsmooth\b/i },
  { name: 'vibe', re: /\b(vibe|vibes|vibin)\b/i },
  { name: 'big-w', re: /\bbig W\b/i },
  { name: 'W', re: /\btake the W\b/i },

  // Emoji-like text markers
  { name: 'fire-emoji', re: /🔥/ },
  { name: 'thumbs-up', re: /👍/ },
  { name: 'clap', re: /👏/ },
  { name: 'heart', re: /❤️|💯/ },
  { name: 'party', re: /🎉/ },
  { name: 'lol-positive', re: /\blol\b/i }, // context-dependent, dreams decide
];

/**
 * Detect feedback in a founder message. Returns null if no pattern
 * matched — the router stamps the pending-feedback file only when
 * this returns non-null.
 *
 * When both polarities match (e.g., "yeah but actually..."), returns
 * 'mixed' — dreams read the quote and decide.
 */
export function detectFeedback(text: string): FeedbackMatch | null {
  if (!text || text.trim().length === 0) return null;

  const correctionHits: string[] = [];
  const correctionTexts: string[] = [];
  const confirmationHits: string[] = [];
  const confirmationTexts: string[] = [];

  for (const p of CORRECTION_PATTERNS) {
    const m = text.match(p.re);
    if (m) {
      correctionHits.push(p.name);
      correctionTexts.push(m[0]);
    }
  }

  for (const p of CONFIRMATION_PATTERNS) {
    const m = text.match(p.re);
    if (m) {
      confirmationHits.push(p.name);
      confirmationTexts.push(m[0]);
    }
  }

  // Subsume overlapping negatives: if a confirmation match's matched
  // substring literally contains a correction match's substring (e.g.,
  // confirmation "not bad" contains correction "not"), drop the
  // correction hit — the compound positive wins the tiebreak. This is
  // the intent documented at the top of CONFIRMATION_PATTERNS.
  const filteredCorrectionIdx: number[] = [];
  const lowerConf = confirmationTexts.map(s => s.toLowerCase());
  for (let i = 0; i < correctionTexts.length; i++) {
    const ct = correctionTexts[i]!.toLowerCase();
    const subsumed = lowerConf.some(cft => cft !== ct && cft.includes(ct));
    if (!subsumed) filteredCorrectionIdx.push(i);
  }
  const keptCorrectionHits = filteredCorrectionIdx.map(i => correctionHits[i]!);
  const keptCorrectionTexts = filteredCorrectionIdx.map(i => correctionTexts[i]!);

  const hasNeg = keptCorrectionHits.length > 0;
  const hasPos = confirmationHits.length > 0;

  if (!hasNeg && !hasPos) return null;

  let polarity: FeedbackPolarity;
  if (hasNeg && hasPos) polarity = 'mixed';
  else if (hasNeg) polarity = 'correction';
  else polarity = 'confirmation';

  return {
    polarity,
    matchedPatterns: [...keptCorrectionHits, ...confirmationHits],
    matchedText: [...keptCorrectionTexts, ...confirmationTexts],
  };
}

/** For tests + debugging — exposed pattern counts. */
export const FEEDBACK_PATTERN_COUNTS = {
  correction: CORRECTION_PATTERNS.length,
  confirmation: CONFIRMATION_PATTERNS.length,
};
