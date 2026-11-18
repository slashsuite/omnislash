import { integer, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { isSmoke } from "./synthetic";

export const accounts = sqliteTable("accounts", {
  id: text("id").primaryKey(),
  email: text("email").notNull().unique(),
  createdAt: integer("created_at", { mode: "timestamp" }).notNull(),
  isSmoke: isSmoke(),
});
