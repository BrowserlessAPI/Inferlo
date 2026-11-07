// The existing app's Sequelize models, defined with sequelize.define (no decorators, no classes needed).
import { DataTypes, type InferAttributes, type InferCreationAttributes, type CreationOptional, type Model, type Sequelize } from "sequelize";

export interface Customer extends Model<InferAttributes<Customer>, InferCreationAttributes<Customer>> {
  id: CreationOptional<number>;
  name: string;
}

export interface Order extends Model<InferAttributes<Order>, InferCreationAttributes<Order>> {
  id: CreationOptional<number>;
  customerId: number;
  reference: string;
  cents: number;
}

export function defineModels(sequelize: Sequelize) {
  const Customer = sequelize.define<Customer>("Customer", {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    name: { type: DataTypes.STRING(200), allowNull: false },
  }, { tableName: "shop_customers", underscored: true });

  const Order = sequelize.define<Order>("Order", {
    id: { type: DataTypes.INTEGER, autoIncrement: true, primaryKey: true },
    customerId: { type: DataTypes.INTEGER, allowNull: false },
    reference: { type: DataTypes.STRING(40), allowNull: false, unique: true },
    cents: { type: DataTypes.INTEGER, allowNull: false },
  }, { tableName: "shop_orders", underscored: true });

  Customer.hasMany(Order, { foreignKey: "customerId", as: "orders" });
  Order.belongsTo(Customer, { foreignKey: "customerId", as: "customer" });
  return { Customer, Order };
}
