interface Customer {
  firstName: string;
  lastName: string;
}

const customer: Customer = { firstName: "Ada", lastName: "Lovelace" };

export function displayName(): string {
  return `${customer.fristName} ${customer.lastName}`;
}
