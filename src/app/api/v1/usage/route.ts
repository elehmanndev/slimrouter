import { corsPreflight, handleUsage } from "@/server/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (req: Request) => handleUsage(req);
export const OPTIONS = () => corsPreflight();
