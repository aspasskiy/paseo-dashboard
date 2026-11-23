import { join } from "node:path";
import type { RpcOutput } from "@getpaseo/plugin";
import { layoutSchema, type layoutGetRpc, type layoutSetRpc, type DashboardLayout } from "../shared/rpc";
import { dataDir, readJson, writeJson } from "./paths";

const FILE = () => join(dataDir(), "layout.json");

/** The saved grid layout (any version; the client migrates), or null for the default layout. Shared by every client of this daemon. */
export async function getLayout(): Promise<RpcOutput<typeof layoutGetRpc>> {
  const parsed = layoutSchema.safeParse(await readJson(FILE()));
  return { layout: parsed.success ? parsed.data : null };
}

export async function setLayout(input: { layout: DashboardLayout }): Promise<RpcOutput<typeof layoutSetRpc>> {
  await writeJson(FILE(), input.layout);
  return { ok: true };
}
