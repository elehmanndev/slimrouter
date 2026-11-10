import { corsPreflight, handleChat } from "@/server/handlers";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

export const POST = (req: Request) => handleChat(req, "claude");
export const OPTIONS = () => corsPreflight();
