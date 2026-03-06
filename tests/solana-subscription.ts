import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { SolanaSubscription } from "../target/types/solana_subscription";
import {
  Keypair,
  PublicKey,
  SystemProgram,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  createMint,
  createAccount,
  mintTo,
  getAccount,
  approve,
} from "@solana/spl-token";
import { expect } from "chai";

describe("solana-subscription", () => {
  const provider = anchor.AnchorProvider.env();
  anchor.setProvider(provider);

  const program = anchor.workspace
    .solanaSubscription as Program<SolanaSubscription>;

  // Merchant is the provider wallet
  const merchantAuthority = provider.wallet as anchor.Wallet;
  // Subscriber is a separate keypair
  const subscriber = Keypair.generate();

  let mint: PublicKey;
  let merchantTreasury: PublicKey;
  let subscriberTokenAccount: PublicKey;
  let merchantPda: PublicKey;
  let subscriptionPda: PublicKey;

  const SUBSCRIPTION_AMOUNT = new anchor.BN(5_000_000); // 5 tokens (6 decimals)
  const INTERVAL = new anchor.BN(60); // 60 seconds

  before(async () => {
    const conn = provider.connection;

    // Fund subscriber
    const sig = await conn.requestAirdrop(
      subscriber.publicKey,
      2 * LAMPORTS_PER_SOL
    );
    await conn.confirmTransaction(sig);

    // Create mint
    mint = await createMint(
      conn,
      (merchantAuthority as any).payer,
      merchantAuthority.publicKey,
      null,
      6
    );

    // Merchant treasury token account
    merchantTreasury = await createAccount(
      conn,
      (merchantAuthority as any).payer,
      mint,
      merchantAuthority.publicKey
    );

    // Subscriber token account — fund it
    subscriberTokenAccount = await createAccount(
      conn,
      (merchantAuthority as any).payer,
      mint,
      subscriber.publicKey
    );
    await mintTo(
      conn,
      (merchantAuthority as any).payer,
      mint,
      subscriberTokenAccount,
      merchantAuthority.publicKey,
      100_000_000
    );

    // Derive PDAs
    [merchantPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("merchant"), merchantAuthority.publicKey.toBuffer()],
      program.programId
    );

    [subscriptionPda] = PublicKey.findProgramAddressSync(
      [
        Buffer.from("subscription"),
        subscriber.publicKey.toBuffer(),
        merchantPda.toBuffer(),
      ],
      program.programId
    );
  });

  it("register_merchant — creates merchant account", async () => {
    await program.methods
      .registerMerchant()
      .accounts({
        merchantAccount: merchantPda,
        treasury: merchantTreasury,
        authority: merchantAuthority.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .rpc();

    const merchant = await program.account.merchantAccount.fetch(merchantPda);
    expect(merchant.authority.toBase58()).to.equal(
      merchantAuthority.publicKey.toBase58()
    );
    expect(merchant.treasury.toBase58()).to.equal(merchantTreasury.toBase58());
  });

  it("create_subscription — subscriber creates subscription", async () => {
    await program.methods
      .createSubscription(SUBSCRIPTION_AMOUNT, INTERVAL)
      .accounts({
        subscription: subscriptionPda,
        merchantAccount: merchantPda,
        mint,
        subscriber: subscriber.publicKey,
        systemProgram: SystemProgram.programId,
      })
      .signers([subscriber])
      .rpc();

    const sub = await program.account.subscription.fetch(subscriptionPda);
    expect(sub.subscriber.toBase58()).to.equal(subscriber.publicKey.toBase58());
    expect(sub.merchant.toBase58()).to.equal(merchantPda.toBase58());
    expect(sub.mint.toBase58()).to.equal(mint.toBase58());
    expect(sub.amount.toNumber()).to.equal(SUBSCRIPTION_AMOUNT.toNumber());
    expect(sub.interval.toNumber()).to.equal(INTERVAL.toNumber());
    expect(sub.active).to.equal(true);
  });

  it("charge — charge the subscription", async () => {
    // The program uses the subscription PDA as the transfer authority.
    // We need to delegate token authority to the subscription PDA so the
    // CPI transfer can succeed.
    await approve(
      provider.connection,
      (merchantAuthority as any).payer,
      subscriberTokenAccount,
      subscriptionPda,
      subscriber,
      100_000_000
    );

    const treasuryBefore = await getAccount(
      provider.connection,
      merchantTreasury
    );
    const subscriberBefore = await getAccount(
      provider.connection,
      subscriberTokenAccount
    );

    await program.methods
      .charge()
      .accounts({
        subscription: subscriptionPda,
        merchantAccount: merchantPda,
        subscriberTokenAccount,
        merchantTreasury,
        tokenProgram: TOKEN_PROGRAM_ID,
      })
      .rpc();

    // Verify tokens moved
    const treasuryAfter = await getAccount(
      provider.connection,
      merchantTreasury
    );
    const subscriberAfter = await getAccount(
      provider.connection,
      subscriberTokenAccount
    );

    expect(Number(treasuryAfter.amount)).to.equal(
      Number(treasuryBefore.amount) + SUBSCRIPTION_AMOUNT.toNumber()
    );
    expect(Number(subscriberAfter.amount)).to.equal(
      Number(subscriberBefore.amount) - SUBSCRIPTION_AMOUNT.toNumber()
    );

    // Verify next_charge_ts was advanced
    const sub = await program.account.subscription.fetch(subscriptionPda);
    expect(sub.nextChargeTs.toNumber()).to.be.greaterThan(0);
  });

  it("error: charge when not due — should fail", async () => {
    // We just charged, so next_charge_ts is in the future.
    try {
      await program.methods
        .charge()
        .accounts({
          subscription: subscriptionPda,
          merchantAccount: merchantPda,
          subscriberTokenAccount,
          merchantTreasury,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      expect.fail("Should have thrown ChargeNotDue error");
    } catch (err: any) {
      const code = err.error?.errorCode?.code || err.message;
      expect(code).to.include("ChargeNotDue");
    }
  });

  it("cancel_subscription — subscriber cancels", async () => {
    await program.methods
      .cancelSubscription()
      .accounts({
        subscription: subscriptionPda,
        subscriber: subscriber.publicKey,
      })
      .signers([subscriber])
      .rpc();

    const sub = await program.account.subscription.fetch(subscriptionPda);
    expect(sub.active).to.equal(false);
  });

  it("error: charge cancelled subscription — should fail", async () => {
    try {
      await program.methods
        .charge()
        .accounts({
          subscription: subscriptionPda,
          merchantAccount: merchantPda,
          subscriberTokenAccount,
          merchantTreasury,
          tokenProgram: TOKEN_PROGRAM_ID,
        })
        .rpc();
      expect.fail("Should have thrown NotActive error");
    } catch (err: any) {
      const code = err.error?.errorCode?.code || err.message;
      expect(code).to.include("NotActive");
    }
  });
});
