// Merchant name normalization and the built-in merchant dictionary.
// The dictionary covers common Azerbaijani and international merchants so that
// most everyday purchases are categorized instantly without any AI call.

import { foldText } from "./parser";

const LEGAL_AND_PLACE =
  /\b(BAKU|BAKI|BAKU CITY|AZ|AZE|AZERBAIJAN|AZERBAYCAN|SUMQAYIT|SUMGAIT|GANJA|GENCE|XIRDALAN|KHIRDALAN|LTD|LLC|MMC|ASC|QSC|OJSC|CJSC|INC|CO|BRANCH|FILIAL|POS|ECOM|TERMINAL)\b/g;

/** Stable key used to recognise the same merchant across messages, e.g. "BRAVO SUPERMARKET 0123 BAKU AZ" -> "BRAVO SUPERMARKET". */
export function merchantKey(raw: string): string {
  let s = foldText(raw).toUpperCase();
  s = s.replace(/HTTPS?:\/\//g, " ").replace(/\bWWW\./g, " ");
  s = s.replace(/\.(COM|AZ|NET|ORG|IO|EU|CO|APP|ME|SHOP|STORE|TV)\b/g, " ");
  s = s.replace(/[^A-Z0-9А-ЯЁ ]+/g, " ");
  s = s.replace(LEGAL_AND_PLACE, " ");
  s = s.replace(/\b\d+\b/g, " ");
  s = s.replace(/\s+/g, " ").trim();
  const key = s.split(" ").slice(0, 4).join(" ");
  return key || foldText(raw).toUpperCase().replace(/\s+/g, " ").trim().slice(0, 40);
}

/** "BRAVO SUPERMARKET" -> "Bravo Supermarket"; keeps short acronyms like "KFC" as-is. */
export function prettifyMerchant(raw: string): string {
  const cleaned = raw.replace(/\s+/g, " ").trim();
  if (cleaned !== cleaned.toUpperCase()) return cleaned;
  return cleaned
    .split(" ")
    .map((w) => (w.length <= 3 && /^[A-Z]+$/.test(w) ? w : w.charAt(0) + w.slice(1).toLowerCase()))
    .join(" ");
}

export interface BuiltinMatch {
  slug: string;
  name: string;
}

// [alternatives matched as whole words in the merchant key, category slug, display name].
// Order matters: the first match wins, so specific names come before generic words.
const DICTIONARY_SOURCE: [string, string, string][] = [
  // Groceries & supermarkets (Azerbaijan)
  ["BRAVO", "food.supermarket", "Bravo"],
  ["ARAZ", "food.supermarket", "Araz Market"],
  ["BAZARSTORE|BAZAR STORE", "food.supermarket", "Bazarstore"],
  ["OBA", "food.supermarket", "OBA Market"],
  ["RAHAT", "food.supermarket", "Rahat"],
  ["AL MARKET", "food.supermarket", "Al Market"],
  ["NEPTUN", "food.supermarket", "Neptun"],
  ["FAMILY MARKET", "food.supermarket", "Family Market"],
  ["MEGASTORE|MEGA STORE", "food.supermarket", "Megastore"],
  ["SPAR", "food.supermarket", "Spar"],
  ["GRAND MART|GRANDMART", "food.supermarket", "Grand Mart"],
  ["TAMSTORE|TAM STORE", "food.supermarket", "Tamstore"],
  ["FRESCO", "food.supermarket", "Fresco"],
  ["CARREFOUR", "food.supermarket", "Carrefour"],
  ["MARKET|SUPERMARKET|HYPERMARKET|MARKET", "food.supermarket", ""],
  ["CHOPAR|CHORAK|CORAK|BAKERY|PEKARNYA|ENTREE|BREAD|BULKA", "food.bakery", ""],
  ["BAZAR|BAZAAR|RYNOK|TEZE BAZAR|YASIL BAZAR|VEGETABLES|FRUIT|FRUITS|MEYVE|TEREVEZ|GROCERIES", "food.market", ""],
  // Eating out
  ["WOLT", "dining.delivery", "Wolt"],
  ["BOLT FOOD", "dining.delivery", "Bolt Food"],
  ["YANGO DELI|YANGO FOOD", "dining.delivery", "Yango Food"],
  ["FOODY|FOODERS|GLOVO|UBER EATS", "dining.delivery", ""],
  ["MCDONALD|MC DONALD", "dining.fastfood", "McDonald's"],
  ["KFC", "dining.fastfood", "KFC"],
  ["BURGER KING", "dining.fastfood", "Burger King"],
  ["PAPA JOHN", "dining.fastfood", "Papa John's"],
  ["DOMINO", "dining.fastfood", "Domino's"],
  ["PIZZA HUT", "dining.fastfood", "Pizza Hut"],
  ["DONER|DÖNER|SHAURMA|SHAWARMA|LAVASH|BURGER|PIZZA", "dining.fastfood", ""],
  ["STARBUCKS", "dining.cafe", "Starbucks"],
  ["COFFEE MOFFIE", "dining.cafe", "Coffee Moffie"],
  ["GLORIA JEAN", "dining.cafe", "Gloria Jean's"],
  ["COSTA COFFEE", "dining.cafe", "Costa Coffee"],
  ["COFFEE|KOFE|CAFE|KAFE|COFFESHOP|ESPRESSO|BARISTA|CAY EVI|CHAYXANA|CAYXANA|TEA HOUSE", "dining.cafe", ""],
  ["RESTORAN|RESTAURANT|KABAB|KEBAB|GRILL|STEAK|SUSHI|BISTRO|DINER|TRATTORIA|LUNCH|DINNER|BREAKFAST|NAHAR|SHAM YEMEYI", "dining.restaurant", ""],
  ["PUB|LOUNGE|BAR", "dining.bar", ""],
  // Transport
  ["BOLT", "transport.taxi", "Bolt"],
  ["UBER", "transport.taxi", "Uber"],
  ["YANGO", "transport.taxi", "Yango"],
  ["TAXI|TAKSI", "transport.taxi", ""],
  ["BAKIKART|BAKI KART|BAKUCARD|BAKU CARD|METRO|BAKU BUS|BAKUBUS", "transport.public", "Metro & bus"],
  ["SOCAR", "transport.fuel", "SOCAR Petroleum"],
  ["AZPETROL", "transport.fuel", "Azpetrol"],
  ["LUKOIL", "transport.fuel", "Lukoil"],
  ["PETROL|AZS|YANACAQ|FUEL|BENZIN", "transport.fuel", ""],
  ["PARKING|PARKOVKA|DAYANACAQ", "transport.parking", ""],
  ["AVTOYUMA|CAR WASH|MOYKA", "transport.carwash", ""],
  ["DYP|CERIME|JERIME|FINE", "transport.fines", ""],
  // Utilities & telecom
  ["AZERCELL", "utilities.mobile", "Azercell"],
  ["BAKCELL", "utilities.mobile", "Bakcell"],
  ["NAR MOBILE|NARMOBILE|AZERFON", "utilities.mobile", "Nar"],
  ["AZERISIQ|AZERISHIQ|AZERENERJI", "utilities.electricity", "Azərişıq"],
  ["AZERIQAZ|AZERIGAZ", "utilities.gas", "Azəriqaz"],
  ["AZERSU", "utilities.water", "Azərsu"],
  ["CITYNET|AZTELEKOM|BAKTELECOM|KATV|ULTEL|AZERONLINE|SMART HOME|ALFANET", "utilities.internet", ""],
  ["MILLIKART|MILLI ON|EMANAT|E MANAT|GOLDENPAY|PORTMANAT", "utilities.mobile", ""],
  // Shopping
  ["TRENDYOL", "shopping.online", "Trendyol"],
  ["ALIEXPRESS|ALIBABA", "shopping.online", "AliExpress"],
  ["AMAZON", "shopping.online", "Amazon"],
  ["TEMU", "shopping.online", "Temu"],
  ["UMICO", "shopping.online", "Umico"],
  ["BIRMARKET", "shopping.online", "Birmarket"],
  ["TAP AZ|TAPAZ", "shopping.online", "Tap.az"],
  ["KONTAKT", "shopping.electronics", "Kontakt Home"],
  ["IRSHAD|IRSAD", "shopping.electronics", "İrşad"],
  ["BAKU ELECTRONICS|BAKUELECTRONICS", "shopping.electronics", "Baku Electronics"],
  ["APPLE STORE|ALMA STORE", "shopping.electronics", ""],
  ["ZARA|BERSHKA|PULL BEAR|STRADIVARIUS|MANGO|LC WAIKIKI|LCW|DEFACTO|KOTON|H M|MASSIMO DUTTI|COLINS|MAVI|ADIDAS|NIKE|PUMA|NEW BALANCE|SKECHERS|ZOLLA|OYSHO|PULL AND BEAR", "shopping.clothing", ""],
  ["SPORTMASTER|DECATHLON", "sport.equipment", ""],
  ["IDEAL|SEPHORA|GOLDEN ROSE|FLORMAR|WATSONS|GRATIS|MAKEUP|PARFUM|PERFUME|L ETOILE", "shopping.beauty", ""],
  ["IKEA|JYSK|HOME CENTER|MADAME COCO|ENGLISH HOME|KOROGLU|MOBEL|MEBEL", "housing.furniture", ""],
  ["PORT BAKU MALL|28 MALL|GANJLIK MALL|PARK BULVAR|DENIZ MALL|CRESCENT MALL|AMBURAN MALL", "shopping.clothing", ""],
  // Health & care
  ["ZEYTUN|APTEK|APTEKA|PHARM|AVROMED|PHARMASTORE|BUTA APTEK", "health.pharmacy", ""],
  ["KLINIKA|CLINIC|HOSPITAL|XESTEXANA|MEDICAL|MEDICLUB|MEDIDENT|LEYLA MEDICAL|YENI KLINIKA", "health.doctor", ""],
  ["DENTAL|STOMATOLOG|DENT", "health.dental", ""],
  ["OPTIK|OPTICS|OPTIKA", "health.optics", ""],
  ["BARBER|BERBER|SALON|GOZELLIK|BEAUTY", "personal.barber", ""],
  ["SPA|MASSAGE|MASAJ", "personal.spa", ""],
  ["GYM|FITNESS|SPORT CLUB|CROSSFIT|YOGA|PILATES|SPORTLIFE|SPORT LIFE|WORLD CLASS", "sport.gym", ""],
  // Entertainment & subscriptions
  ["PARK CINEMA|CINEMAPLUS|CINEMA PLUS|NIZAMI KINO|CINEMA|KINO", "entertainment.cinema", ""],
  ["ISET|ITICKET|TICKET", "entertainment.cinema", ""],
  ["STEAM|PLAYSTATION|PSN|XBOX|NINTENDO|EPIC GAMES|RIOT|BLIZZARD", "entertainment.games", ""],
  ["NETFLIX", "subscriptions.streaming", "Netflix"],
  ["SPOTIFY", "subscriptions.streaming", "Spotify"],
  ["YOUTUBE", "subscriptions.streaming", "YouTube Premium"],
  ["DISNEY|HBO|MEGOGO|IVI|KINOPOISK|APPLE TV|DEEZER|TIDAL|PRIME VIDEO", "subscriptions.streaming", ""],
  ["OPENAI|CHATGPT|ANTHROPIC|CLAUDE|MIDJOURNEY|PERPLEXITY|CURSOR", "subscriptions.ai", ""],
  ["ICLOUD|DROPBOX|GOOGLE ONE|GOOGLE STORAGE", "subscriptions.cloud", ""],
  ["APPLE COM|APPLE BILL|ITUNES|GOOGLE PLAY|MICROSOFT|ADOBE|NOTION|CANVA|ZOOM|LINKEDIN|TELEGRAM PREMIUM|GITHUB", "subscriptions.software", ""],
  // Travel
  ["AZAL|AZERBAIJAN AIRLINES|BUTA AIRWAYS|TURKISH AIRLINES|THY|PEGASUS|FLYDUBAI|WIZZ|AIR ARABIA|LUFTHANSA|QATAR AIRWAYS|AIRLINE|AVIA", "travel.flights", ""],
  ["BOOKING|AIRBNB|HOTEL|OTEL|HOSTEL|AGODA|EXPEDIA|MARRIOTT|HILTON|RADISSON|HYATT", "travel.hotels", ""],
  ["ADY|AZERBAIJAN RAILWAYS|RAILWAY|TRAIN", "travel.transport", ""],
  // Education
  ["UDEMY|COURSERA|EDX|SKILLSHARE|DUOLINGO|MASTERCLASS|ACADEMY|AKADEMIYA|KURS", "education.courses", ""],
  ["UNIVERSITY|UNIVERSITET|ADA UNIVERSITY|MEKTEB|SCHOOL", "education.tuition", ""],
  ["ALI NINO|KITAB|BOOKSTORE|BOOK", "entertainment.books", ""],
  // Government, finance, cash
  ["ASAN|E GOV|EGOV|DOVLET|VERGI|TAX|GOMRUK|CUSTOMS|DYP", "finance.taxes", ""],
  ["SIGORTA|INSURANCE|PASHA INSURANCE|ATESHGAH|MEGA SIGORTA", "finance.insurance", ""],
  ["ATM|BANKOMAT|NAGD|CASH", "cash", "Cash withdrawal"],
  // Income descriptions
  ["EMEK HAQQI|MAAS|MAASH|SALARY|ZARPLATA|ЗАРПЛАТА|PAYROLL", "income.salary", "Salary"],
  ["KESBEK|CASHBACK|KEŞBEK", "income.refund", "Cashback"],
  // Pets & charity
  ["PET|ZOO|VET", "pets.food", ""],
  ["XEYRIYYE|CHARITY|DONATE|DONATION|IANE", "giving.charity", ""],
];

const DICTIONARY = DICTIONARY_SOURCE.filter(([alts]) => alts.trim()).map(
  ([alts, slug, name]) => [new RegExp(`\\b(?:${alts})\\b`), slug, name] as const,
);

export function builtinMatch(key: string): BuiltinMatch | null {
  for (const [re, slug, name] of DICTIONARY) {
    if (re.test(key)) return { slug, name };
  }
  return null;
}
