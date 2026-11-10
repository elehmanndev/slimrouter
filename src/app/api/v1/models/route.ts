import { corsPreflight, handleModels } from "@/server/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const GET = (req: Request) => handleModels(req);
export const OPTIONS = () => corsPreflight();
