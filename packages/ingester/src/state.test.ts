import type { PrismaClient } from "@prisma/client";
import type { Client } from "xrpl";
import { describe, expect, it, vi } from "vitest";
import type { DecodedTransaction } from "./decode.js";
import { projectState } from "./state.js";
import type { WatchedEnvironment } from "./subscriber.js";

const loanId = "A".repeat(64);
const setupId = "loan-state-test";
const ledgerIndex = 100;

async function project(txType: string, affectedNode: Record<string, unknown>) {
  const upsert = vi.fn();
  const request = vi.fn().mockResolvedValue({ result: { account_objects: [] } });
  const db = { loanState: { upsert } } as unknown as PrismaClient;
  const client = { request } as unknown as Client;
  const env = { setupId } as WatchedEnvironment;
  const tx: DecodedTransaction = {
    txHash: "B".repeat(64),
    txType,
    ledgerIndex,
    parsed: { TransactionType: txType },
    raw: { meta: { TransactionResult: "tesSUCCESS", AffectedNodes: [affectedNode] } },
  };
  await projectState(db, client, env, tx, "unused");
  return { upsert, request };
}

describe("loan state projection", () => {
  it("records a defaulted loan from LoanManage metadata without reading newer ledger state", async () => {
    const { upsert, request } = await project("LoanManage", {
      ModifiedNode: {
        LedgerEntryType: "Loan",
        LedgerIndex: loanId,
        FinalFields: { Flags: 65536 },
        PreviousFields: { PaymentRemaining: 1, PrincipalOutstanding: "25" },
      },
    });
    expect(request).not.toHaveBeenCalled();
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { setupId_loanId: { setupId, loanId } },
      update: { status: "defaulted", principalOutstanding: 0n, totalOutstanding: 0n, paymentRemaining: 0, updatedLedger: ledgerIndex },
    }));
  });

  it("does not project remaining payments from previous fields when final metadata is absent", async () => {
    const { upsert } = await project("LoanPay", {
      ModifiedNode: {
        LedgerEntryType: "Loan",
        LedgerIndex: loanId,
        PreviousFields: { PaymentRemaining: 1, PrincipalOutstanding: "25" },
      },
    });
    expect(upsert).not.toHaveBeenCalled();
  });

  it("keeps omitted zero fields on an unflagged final payment as repaid", async () => {
    const { upsert } = await project("LoanPay", {
      ModifiedNode: { LedgerEntryType: "Loan", LedgerIndex: loanId, FinalFields: { Flags: 0 } },
    });
    expect(upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: { status: "repaid", principalOutstanding: 0n, totalOutstanding: 0n, paymentRemaining: 0, updatedLedger: ledgerIndex },
    }));
  });
});
