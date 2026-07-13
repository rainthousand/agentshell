interface User {
  name: string;
  id: string;
}

export function createUser(name: string): User {
  return { name };
}
