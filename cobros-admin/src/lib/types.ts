export type Currency = "DOP" | "USD";
export type Channel = "email" | "whatsapp";

export interface Client {
  id: string;
  name: string;
  email: string | null;
  phone: string | null;
  company: string | null;
  tags: string[];
  notes: string | null;
  opt_in_email: boolean;
  opt_in_whatsapp: boolean;
  created_at: string;
}

export interface Invoice {
  id: string;
  client_id: string;
  concept: string;
  amount: number;
  currency: Currency;
  due_date: string;
  status: "pending" | "paid" | "overdue" | "cancelled";
  payment_link: string | null;
  paid_at: string | null;
  last_reminder_at: string | null;
  reminder_count: number;
  created_at: string;
}

export interface MessageLog {
  id: string;
  client_id: string | null;
  channel: Channel;
  kind: "reminder" | "invoice" | "promo";
  recipient: string | null;
  body: string | null;
  status: "sent" | "failed";
  error: string | null;
  created_at: string;
}
