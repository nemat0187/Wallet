// Default category tree. Seeded into the database on first run; the user can
// rename, recolor, archive, delete or add categories afterwards. Built-in
// merchant rules reference categories by `slug`, so renames never break them.

export type CategoryKind = "expense" | "income" | "transfer";

export interface DefaultCategory {
  slug: string;
  name: string;
  icon: string;
  color?: string;
  kind: CategoryKind;
  children?: Omit<DefaultCategory, "kind" | "children" | "color">[];
}

export const DEFAULT_CATEGORIES: DefaultCategory[] = [
  {
    slug: "food",
    name: "Groceries",
    icon: "🛒",
    color: "#16a34a",
    kind: "expense",
    children: [
      { slug: "food.supermarket", name: "Supermarket", icon: "🛒" },
      { slug: "food.market", name: "Bazaar & market", icon: "🥕" },
      { slug: "food.bakery", name: "Bakery & sweets", icon: "🥐" },
      { slug: "food.meat", name: "Butcher & fish", icon: "🥩" },
      { slug: "food.alcohol", name: "Alcohol & tobacco", icon: "🍷" },
    ],
  },
  {
    slug: "dining",
    name: "Eating out",
    icon: "🍽️",
    color: "#ea580c",
    kind: "expense",
    children: [
      { slug: "dining.restaurant", name: "Restaurants", icon: "🍽️" },
      { slug: "dining.cafe", name: "Cafes & coffee", icon: "☕" },
      { slug: "dining.fastfood", name: "Fast food", icon: "🍔" },
      { slug: "dining.delivery", name: "Food delivery", icon: "🛵" },
      { slug: "dining.bar", name: "Bars & nightlife", icon: "🍸" },
    ],
  },
  {
    slug: "transport",
    name: "Transport",
    icon: "🚕",
    color: "#2563eb",
    kind: "expense",
    children: [
      { slug: "transport.taxi", name: "Taxi & ride-hailing", icon: "🚕" },
      { slug: "transport.public", name: "Metro & bus", icon: "🚇" },
      { slug: "transport.fuel", name: "Fuel", icon: "⛽" },
      { slug: "transport.parking", name: "Parking & tolls", icon: "🅿️" },
      { slug: "transport.service", name: "Car service & repair", icon: "🔧" },
      { slug: "transport.carwash", name: "Car wash", icon: "🧽" },
      { slug: "transport.fines", name: "Traffic fines", icon: "🚨" },
      { slug: "transport.insurance", name: "Car insurance", icon: "🛡️" },
    ],
  },
  {
    slug: "housing",
    name: "Housing",
    icon: "🏠",
    color: "#7c3aed",
    kind: "expense",
    children: [
      { slug: "housing.rent", name: "Rent", icon: "🔑" },
      { slug: "housing.mortgage", name: "Mortgage", icon: "🏦" },
      { slug: "housing.maintenance", name: "Repairs & maintenance", icon: "🛠️" },
      { slug: "housing.furniture", name: "Furniture & home goods", icon: "🛋️" },
      { slug: "housing.household", name: "Household supplies", icon: "🧴" },
      { slug: "housing.building", name: "Building fees (MTK)", icon: "🏢" },
    ],
  },
  {
    slug: "utilities",
    name: "Bills & utilities",
    icon: "💡",
    color: "#ca8a04",
    kind: "expense",
    children: [
      { slug: "utilities.electricity", name: "Electricity", icon: "⚡" },
      { slug: "utilities.gas", name: "Gas", icon: "🔥" },
      { slug: "utilities.water", name: "Water", icon: "💧" },
      { slug: "utilities.internet", name: "Internet & TV", icon: "🌐" },
      { slug: "utilities.mobile", name: "Mobile phone", icon: "📱" },
    ],
  },
  {
    slug: "shopping",
    name: "Shopping",
    icon: "🛍️",
    color: "#db2777",
    kind: "expense",
    children: [
      { slug: "shopping.clothing", name: "Clothing & shoes", icon: "👕" },
      { slug: "shopping.electronics", name: "Electronics", icon: "💻" },
      { slug: "shopping.online", name: "Online marketplaces", icon: "📦" },
      { slug: "shopping.beauty", name: "Cosmetics & perfume", icon: "💄" },
      { slug: "shopping.gifts", name: "Gifts", icon: "🎁" },
      { slug: "shopping.accessories", name: "Accessories & jewelry", icon: "⌚" },
    ],
  },
  {
    slug: "health",
    name: "Health",
    icon: "💊",
    color: "#dc2626",
    kind: "expense",
    children: [
      { slug: "health.pharmacy", name: "Pharmacy", icon: "💊" },
      { slug: "health.doctor", name: "Doctor & clinic", icon: "🩺" },
      { slug: "health.dental", name: "Dental", icon: "🦷" },
      { slug: "health.insurance", name: "Health insurance", icon: "🛡️" },
      { slug: "health.optics", name: "Optics", icon: "👓" },
    ],
  },
  {
    slug: "personal",
    name: "Personal care",
    icon: "💈",
    color: "#0d9488",
    kind: "expense",
    children: [
      { slug: "personal.barber", name: "Barber & salon", icon: "💈" },
      { slug: "personal.spa", name: "Spa & massage", icon: "💆" },
    ],
  },
  {
    slug: "sport",
    name: "Sport & fitness",
    icon: "🏋️",
    color: "#059669",
    kind: "expense",
    children: [
      { slug: "sport.gym", name: "Gym membership", icon: "🏋️" },
      { slug: "sport.classes", name: "Classes & coaching", icon: "🤸" },
      { slug: "sport.equipment", name: "Sports gear", icon: "👟" },
    ],
  },
  {
    slug: "entertainment",
    name: "Entertainment",
    icon: "🎬",
    color: "#9333ea",
    kind: "expense",
    children: [
      { slug: "entertainment.cinema", name: "Cinema & events", icon: "🎬" },
      { slug: "entertainment.games", name: "Games", icon: "🎮" },
      { slug: "entertainment.hobbies", name: "Hobbies", icon: "🎨" },
      { slug: "entertainment.books", name: "Books & music", icon: "📚" },
    ],
  },
  {
    slug: "subscriptions",
    name: "Subscriptions",
    icon: "🔁",
    color: "#4f46e5",
    kind: "expense",
    children: [
      { slug: "subscriptions.streaming", name: "Streaming (video & music)", icon: "📺" },
      { slug: "subscriptions.software", name: "Apps & software", icon: "🧩" },
      { slug: "subscriptions.cloud", name: "Cloud storage", icon: "☁️" },
      { slug: "subscriptions.ai", name: "AI tools", icon: "🤖" },
    ],
  },
  {
    slug: "education",
    name: "Education",
    icon: "🎓",
    color: "#0891b2",
    kind: "expense",
    children: [
      { slug: "education.courses", name: "Courses & training", icon: "🧑‍🏫" },
      { slug: "education.tuition", name: "School & university", icon: "🎓" },
      { slug: "education.supplies", name: "Books & supplies", icon: "✏️" },
    ],
  },
  {
    slug: "travel",
    name: "Travel",
    icon: "✈️",
    color: "#0284c7",
    kind: "expense",
    children: [
      { slug: "travel.flights", name: "Flights", icon: "✈️" },
      { slug: "travel.hotels", name: "Hotels & stays", icon: "🏨" },
      { slug: "travel.transport", name: "Trains, buses & car rental", icon: "🚆" },
      { slug: "travel.activities", name: "Tours & activities", icon: "🗺️" },
      { slug: "travel.visa", name: "Visa & travel fees", icon: "🛂" },
    ],
  },
  {
    slug: "family",
    name: "Family & kids",
    icon: "👨‍👩‍👧",
    color: "#e11d48",
    kind: "expense",
    children: [
      { slug: "family.childcare", name: "Childcare", icon: "🧸" },
      { slug: "family.school", name: "Kids' school & activities", icon: "🎒" },
      { slug: "family.support", name: "Support to relatives", icon: "🤝" },
    ],
  },
  {
    slug: "pets",
    name: "Pets",
    icon: "🐾",
    color: "#a16207",
    kind: "expense",
    children: [
      { slug: "pets.food", name: "Pet food & supplies", icon: "🦴" },
      { slug: "pets.vet", name: "Vet", icon: "🐕" },
    ],
  },
  {
    slug: "finance",
    name: "Fees & finance",
    icon: "🏦",
    color: "#475569",
    kind: "expense",
    children: [
      { slug: "finance.fees", name: "Bank & card fees", icon: "🧾" },
      { slug: "finance.loan", name: "Loan repayment", icon: "💳" },
      { slug: "finance.interest", name: "Interest paid", icon: "📉" },
      { slug: "finance.insurance", name: "Insurance", icon: "🛡️" },
      { slug: "finance.taxes", name: "Taxes & government", icon: "🏛️" },
    ],
  },
  {
    slug: "giving",
    name: "Gifts & donations",
    icon: "🎁",
    color: "#be185d",
    kind: "expense",
    children: [
      { slug: "giving.charity", name: "Charity", icon: "❤️" },
      { slug: "giving.gifts", name: "Gifts to others", icon: "🎀" },
      { slug: "giving.celebrations", name: "Weddings & celebrations", icon: "🎉" },
    ],
  },
  { slug: "people", name: "Transfers sent", icon: "📤", color: "#78716c", kind: "expense" },
  { slug: "cash", name: "Cash withdrawal", icon: "🏧", color: "#64748b", kind: "expense" },
  { slug: "other", name: "Other expenses", icon: "📌", color: "#94a3b8", kind: "expense" },
  { slug: "uncategorized", name: "Uncategorized", icon: "❔", color: "#cbd5e1", kind: "expense" },

  {
    slug: "income",
    name: "Income",
    icon: "💰",
    color: "#15803d",
    kind: "income",
    children: [
      { slug: "income.salary", name: "Salary", icon: "💼" },
      { slug: "income.bonus", name: "Bonus", icon: "🎯" },
      { slug: "income.freelance", name: "Freelance & side income", icon: "🧑‍💻" },
      { slug: "income.refund", name: "Refunds & cashback", icon: "↩️" },
      { slug: "income.interest", name: "Interest & dividends", icon: "📈" },
      { slug: "income.gift", name: "Gifts received", icon: "🎁" },
      { slug: "income.transfer", name: "Transfers received", icon: "📥" },
      { slug: "income.other", name: "Other income", icon: "➕" },
    ],
  },
  {
    slug: "transfer",
    name: "Transfers",
    icon: "🔄",
    color: "#6b7280",
    kind: "transfer",
    children: [
      { slug: "transfer.own", name: "Between my accounts", icon: "🔄" },
      { slug: "transfer.savings", name: "To savings", icon: "🐷" },
      { slug: "transfer.card_payment", name: "Credit card repayment", icon: "💳" },
    ],
  },
];

/** Fallback category slugs used when nothing else matches. */
export const FALLBACK_SLUG: Record<CategoryKind, string> = {
  expense: "uncategorized",
  income: "income.other",
  transfer: "transfer.own",
};
