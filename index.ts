require("dotenv").config();
require("./patch.js");
import bodyParser from "body-parser";
import cors from "cors";
import express, { Express, Request, Response } from "express";
import httpStatus from "http-status";
import path from "path";
import { getPositions } from "./src/utils/utils";

const app: Express = express();
app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));
app.use(express.static(path.join(__dirname, "../dist")));

app.get("/positions", async (req: Request, res: Response) => {
  const { account, showlPnl, isPnlIn } = req.query;
  try {
    const positions = await getPositions(
      String(account) || "",
      Boolean(showlPnl) || false,
      Boolean(isPnlIn) || false
    );
    res.status(httpStatus.OK).json({ success: true, positions });
  } catch (err) {
    res.status(httpStatus.BAD_REQUEST).json({
      success: false,
      message: err.shortMessage || err.message || err,
    });
  }
});

const port = process.env.PORT || 5000;
app.listen(port, () => {
  console.log(`⚡️[server]: Server is running at http://localhost:${port}`);
});
