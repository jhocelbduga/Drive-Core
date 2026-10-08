export type Actor = { tenant: string; subject: string; roles: string[]; hubs: string[] };
export type Revenue = { currency: string; today: number; week: number; month: number; year: number };
export type Hub = {
  id: string; name: string; region: string; kind: string; status: string; bays: number; latitude: number; longitude: number;
  availableUnits: number; lowStockPositions: number; stockPositions: number; completedOrders: number; revenue: Revenue[]; lastEvent: string | null;
};
export type Snapshot = { generatedAt: string; consistency: string; coverage: string; hubs: Hub[]; deadLetters: number; pendingInbox: number; pendingOutbox: number };
export type Product = { id: string; name: string; sku: string; category: string; kind: string; price: number; currency: string };
export type Order = { id: string; hubId: string; total: number; currency: string; status: string; failure: string | null; settlementReference: string | null };
export type Stored<T> = { id: string; data: T; version: number };
export type Stock = { hubId: string; productId: string; onHand: number; reserved: number; available: number; safetyStock: number; version: number };
export function can(actor: Actor, ...roles: string[]) {
  return actor.roles.some(role => role === "Corporate Administrator" || role === "Product Owner" || roles.includes(role));
}
export function money(amount: number, currency: string) {
  return new Intl.NumberFormat("en", { style: "currency", currency }).format(amount / 100);
}
export function totals(hubs: readonly Pick<Hub, "revenue">[], currency: string) {
  return hubs.reduce((sum, hub) => {
    const row = hub.revenue.find(revenue => revenue.currency === currency);
    return { today: sum.today + (row?.today ?? 0), week: sum.week + (row?.week ?? 0), month: sum.month + (row?.month ?? 0), year: sum.year + (row?.year ?? 0) };
  }, { today: 0, week: 0, month: 0, year: 0 });
}
