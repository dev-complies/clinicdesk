/**
 * Emergency phrase list for ClinicDesk guardrail.
 *
 * Rules:
 * - Matching is done on the NFKC-normalised, lowercased, punctuation-stripped message.
 * - False positives are acceptable; false negatives are not.
 * - Phrases are split into two categories:
 *   - MEDICAL_EMERGENCY: physical medical crises → directs to 112 / nearest hospital
 *   - SELF_HARM: suicide / self-harm expressions → directs to 112 + Tele-MANAS helpline
 *
 * To add new phrases: append to the relevant array and redeploy.
 * Sources for official helpline numbers:
 *   - Emergency (India): 112 (national single emergency number)
 *   - Tele-MANAS (Ministry of Health & Family Welfare / NIMHANS): 14416 / 1800-891-4416
 *     https://mohfw.gov.in and https://pib.gov.in (Government of India press release)
 */

export const MEDICAL_EMERGENCY_PHRASES: readonly string[] = [
  // English – cardiac / respiratory
  "chest pain",
  "chest pressure",
  "chest tightness",
  "heart attack",
  "cant breathe",
  "can't breathe",
  "cannot breathe",
  "difficulty breathing",
  "not breathing",
  "stopped breathing",
  "shortness of breath",
  "trouble breathing",
  // English – consciousness / bleeding
  "unconscious",
  "unresponsive",
  "collapsed",
  "fainted",
  "loss of consciousness",
  "passed out",
  "not waking up",
  "heavy bleeding",
  "bleeding badly",
  "bleeding a lot",
  "severe bleeding",
  "bleeding wont stop",
  "bleeding won't stop",
  // English – neurological / other
  "seizure",
  "convulsion",
  "stroke",
  "overdose",
  "drug overdose",
  "poisoning",
  "choking",
  "severe pain",
  "emergency",
  // Hindi Devanagari – cardiac / respiratory
  "सीने में दर्द",
  "सीने मे दर्द",
  "छाती में दर्द",
  "छाती मे दर्द",
  "दिल में दर्द",
  "दिल मे दर्द",
  "सांस नहीं",
  "साँस नहीं",
  "सांस नही",
  // Hindi Devanagari – consciousness / bleeding
  "बेहोश",
  "बहुत खून",
  "खून बह",
  "खून निकल",
  "खून रुक नहीं",
  // Hindi Devanagari – other
  "दौरा",
  "जहर",
  "दम घुट",
  "नब्ज नहीं",
  // Hinglish romanised – cardiac / respiratory
  "seene mein dard",
  "seene me dard",
  "sine mein dard",
  "chhati mein dard",
  "chhati me dard",
  "dil mein dard",
  "dil me dard",
  "saans nahi",
  "sans nahi",
  "saans nahi aa rahi",
  "sans aa nahi rahi",
  // Hinglish romanised – consciousness / bleeding
  "behosh",
  "behosh ho gaya",
  "behosh ho gayi",
  "nahi uth raha",
  "bahut khoon",
  "khoon aa raha",
  "khoon zyada",
  "khoon ruk nahi",
  // Hinglish romanised – other
  "daura pada",
  "daura aa gaya",
  "zahar kha",
  "dam ghut",
  "unconscious ho gaya",
  "unconscious ho gayi",
  "seizure aa",
  "dil ka dora",
] as const;

export const SELF_HARM_PHRASES: readonly string[] = [
  // English
  "kill myself",
  "killing myself",
  "want to die",
  "want to kill myself",
  "end my life",
  "ending my life",
  "take my own life",
  "commit suicide",
  "suicidal",
  "suicide",
  "self harm",
  "self-harm",
  "hurt myself",
  "hurting myself",
  "cut myself",
  // Hindi Devanagari
  "आत्महत्या",
  "खुदकुशी",
  "मरना चाहता",
  "मरना चाहती",
  "मरना चाहूं",
  "जीना नहीं",
  "जीना नही",
  "जान देना",
  "जान दे दूं",
  "खुद को नुकसान",
  // Hinglish romanised
  "aatmahatya",
  "khudkushi",
  "marna chahta",
  "marna chahti",
  "marna chahun",
  "jeena nahi",
  "jaan dena",
  "jaan de du",
  "khud ko nuksan",
  "apni jaan lena",
  "apni jaan lenaa",
] as const;

