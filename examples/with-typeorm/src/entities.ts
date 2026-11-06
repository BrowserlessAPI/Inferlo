// The existing app's TypeORM entities. EntitySchema needs no decorators, so the files run as plain TypeScript;
// decorated entity classes (@Entity, @Column) work the same way next to Inferlo.
import { EntitySchema } from "typeorm";

export interface Account {
  id: number;
  name: string;
  subscriptions?: Subscription[];
}

export interface Subscription {
  id: number;
  accountId: number;
  plan: string;
  cents: number;
  account?: Account;
}

export const AccountEntity = new EntitySchema<Account>({
  name: "Account",
  tableName: "saas_accounts",
  columns: {
    id: { type: Number, primary: true, generated: true },
    name: { type: String },
  },
  relations: {
    subscriptions: { type: "one-to-many", target: "Subscription", inverseSide: "account" },
  },
});

export const SubscriptionEntity = new EntitySchema<Subscription>({
  name: "Subscription",
  tableName: "saas_subscriptions",
  columns: {
    id: { type: Number, primary: true, generated: true },
    accountId: { type: Number, name: "account_id" },
    plan: { type: String },
    cents: { type: "int" },
  },
  relations: {
    account: { type: "many-to-one", target: "Account", joinColumn: { name: "account_id" }, onDelete: "CASCADE" },
  },
});
