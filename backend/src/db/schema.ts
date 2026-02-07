/**
 * Supabase Database Client
 *
 * PostgreSQL database via Supabase for production scalability.
 * Uses @supabase/supabase-js for async database operations.
 */

import { createClient, type SupabaseClient } from "@supabase/supabase-js";
import { config } from "../config/index.js";

let supabase: SupabaseClient | null = null;

/**
 * Get (or create) the singleton Supabase client
 */
export function getDb(): SupabaseClient {
  if (!supabase) {
    supabase = createClient(
      config.database.supabaseUrl,
      config.database.supabaseKey,
      {
        auth: {
          persistSession: false, // Backend doesn't need session persistence
        },
      },
    );
  }
  return supabase;
}

/**
 * Initialize database (no-op for Supabase, schema managed via migrations)
 */
export async function initializeDatabase(): Promise<void> {
  // Verify connection by checking if tables exist
  const db = getDb();
  const { error } = await db
    .from("users")
    .select("count", { count: "exact", head: true });

  if (error) {
    console.error("⚠️ Database connection warning:", error.message);
  } else {
    console.log("✅ Database connected (Supabase)");
  }
}

/**
 * Close the database connection (no-op for Supabase REST client)
 */
export function closeDatabase(): void {
  supabase = null;
  console.log("Database connection closed");
}
