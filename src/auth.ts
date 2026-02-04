import type { Request, Response, NextFunction } from "express";

const TOKEN = process.env.TC_MEMORY_TOKEN;

export function authMiddleware(req: Request, res: Response, next: NextFunction): void {
  // Skip auth for health check
  if (req.path === "/health") {
    next();
    return;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    res.status(401).json({ error: "Missing or invalid Authorization header" });
    return;
  }

  const token = authHeader.slice(7);
  if (token !== TOKEN) {
    res.status(401).json({ error: "Invalid token" });
    return;
  }

  next();
}
