import express from "express";

export function startWebhookServer(processEvent: (event: any) => Promise<void>) {

  const app = express();
  app.use(express.json());

  app.post("/helius-webhook", async (req: any, res: any) => {

     const events = req.body;

     for (const event of events) {
        await processEvent(event);
     }

     res.sendStatus(200);
  });

  app.listen(3001, () => {
     console.log("Webhook server running on port 3001");
  });

}