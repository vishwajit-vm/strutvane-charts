// The generated `.strutvane/types/models.d.ts` of the test app: it tells the framework's typed
// `Model('invoices')` which columns exist (declaration merging into TableRegistry).

/** A row of `invoices`. */
export interface InvoiceRow {
  id: number
  tenant_id: string
  customer_id: number | null
  owner_id: number
  status: 'draft' | 'sent' | 'paid' | 'void'
  paid: boolean
  total: string | null
  discount: number | null
  quantity: number
  issued_on: string | null
  sent_at: Date | null
  api_token: string | null
  internal_note: string | null
  notes: string | null
  created_at: Date | null
  updated_at: Date | null
  deleted_at: Date | null
}

/** What creating an invoice takes. */
export interface NewInvoice {
  customer_id?: number | null
  owner_id?: number
  status?: 'draft' | 'sent' | 'paid' | 'void'
  paid?: boolean
  total?: string | null
  discount?: number | null
  quantity?: number
  issued_on?: string | null
  sent_at?: Date | null
  api_token?: string | null
  internal_note?: string | null
  notes?: string | null
}

/** A row of `employees`. */
export interface EmployeeRow {
  id: number
  tenant_id: string
  department: 'sales' | 'legal' | 'eng' | 'ops'
  remote: boolean
  salary: string
  hired_on: string
  created_at: Date | null
  updated_at: Date | null
}

/** What creating an employee takes. */
export interface NewEmployee {
  department: 'sales' | 'legal' | 'eng' | 'ops'
  remote?: boolean
  salary: string
  hired_on: string
}

declare module '@strutvane/framework/database' {
  interface TableRegistry {
    invoices: { row: InvoiceRow; insert: NewInvoice; update: Partial<NewInvoice>; json: object }
    employees: {
      row: EmployeeRow
      insert: NewEmployee
      update: Partial<NewEmployee>
      json: object
    }
  }
}
