import { Hono } from "hono";
import { cors } from "hono/cors";
import { streamSSE } from "hono/streaming";

const log = logger("http");

const app = new Hono<{ Bindings: Env }>();
