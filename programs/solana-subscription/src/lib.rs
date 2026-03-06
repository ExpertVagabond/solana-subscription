use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("2nj3qrjoiPsxA6sn965UtJeLT5gD8mAFSqFZCsmJQUr2");

#[program]
pub mod solana_subscription {
    use super::*;

    pub fn register_merchant(ctx: Context<RegisterMerchant>) -> Result<()> {
        let m = &mut ctx.accounts.merchant_account;
        m.authority = ctx.accounts.authority.key();
        m.treasury = ctx.accounts.treasury.key();
        m.bump = ctx.bumps.merchant_account;

        emit!(PlanCreated {
            plan: m.key(),
            authority: m.authority,
            mint: ctx.accounts.treasury.mint,
            price: 0,
            interval: 0,
        });

        Ok(())
    }

    pub fn create_subscription(ctx: Context<CreateSubscription>, amount: u64, interval: i64) -> Result<()> {
        let sub = &mut ctx.accounts.subscription;
        sub.subscriber = ctx.accounts.subscriber.key();
        sub.merchant = ctx.accounts.merchant_account.key();
        sub.mint = ctx.accounts.mint.key();
        sub.amount = amount;
        sub.interval = interval;
        sub.next_charge_ts = Clock::get()?.unix_timestamp;
        sub.active = true;
        sub.bump = ctx.bumps.subscription;

        emit!(SubscriptionCreated {
            subscription: sub.key(),
            subscriber: sub.subscriber,
            plan: sub.merchant,
        });

        Ok(())
    }

    pub fn charge(ctx: Context<Charge>) -> Result<()> {
        let sub = &mut ctx.accounts.subscription;
        require!(sub.active, SubError::NotActive);
        let now = Clock::get()?.unix_timestamp;
        require!(now >= sub.next_charge_ts, SubError::ChargeNotDue);
        require_keys_eq!(ctx.accounts.merchant_treasury.key(), ctx.accounts.merchant_account.treasury, SubError::InvalidTreasury);

        let subscriber_key = sub.subscriber;
        let merchant_key = sub.merchant;
        let bump = sub.bump;
        let seeds: &[&[u8]] = &[b"subscription", subscriber_key.as_ref(), merchant_key.as_ref(), &[bump]];

        token::transfer(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            Transfer {
                from: ctx.accounts.subscriber_token_account.to_account_info(),
                to: ctx.accounts.merchant_treasury.to_account_info(),
                authority: sub.to_account_info(),
            },
            &[seeds],
        ), sub.amount)?;

        sub.next_charge_ts = sub.next_charge_ts.checked_add(sub.interval).ok_or(SubError::Overflow)?;

        emit!(PaymentCharged {
            subscription: sub.key(),
            subscriber: sub.subscriber,
            amount: sub.amount,
            next_charge_ts: sub.next_charge_ts,
        });

        Ok(())
    }

    pub fn cancel_subscription(ctx: Context<CancelSubscription>) -> Result<()> {
        let sub = &mut ctx.accounts.subscription;
        require!(ctx.accounts.subscriber.key() == sub.subscriber, SubError::Unauthorized);
        sub.active = false;

        emit!(SubscriptionCancelled {
            subscription: sub.key(),
            subscriber: sub.subscriber,
        });

        Ok(())
    }
}

#[derive(Accounts)]
pub struct RegisterMerchant<'info> {
    #[account(init, payer = authority, space = 8 + MerchantAccount::INIT_SPACE,
        seeds = [b"merchant", authority.key().as_ref()], bump)]
    pub merchant_account: Account<'info, MerchantAccount>,
    pub treasury: Account<'info, TokenAccount>,
    #[account(mut)]
    pub authority: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateSubscription<'info> {
    #[account(init, payer = subscriber, space = 8 + Subscription::INIT_SPACE,
        seeds = [b"subscription", subscriber.key().as_ref(), merchant_account.key().as_ref()], bump)]
    pub subscription: Account<'info, Subscription>,
    pub merchant_account: Account<'info, MerchantAccount>,
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub subscriber: Signer<'info>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Charge<'info> {
    #[account(mut)]
    pub subscription: Account<'info, Subscription>,
    pub merchant_account: Account<'info, MerchantAccount>,
    #[account(mut, constraint = subscriber_token_account.owner == subscription.subscriber,
        constraint = subscriber_token_account.mint == subscription.mint)]
    pub subscriber_token_account: Account<'info, TokenAccount>,
    #[account(mut, constraint = merchant_treasury.mint == subscription.mint)]
    pub merchant_treasury: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct CancelSubscription<'info> {
    #[account(mut)]
    pub subscription: Account<'info, Subscription>,
    pub subscriber: Signer<'info>,
}

#[account]
#[derive(InitSpace)]
pub struct MerchantAccount {
    pub authority: Pubkey,
    pub treasury: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Subscription {
    pub subscriber: Pubkey,
    pub merchant: Pubkey,
    pub mint: Pubkey,
    pub amount: u64,
    pub interval: i64,
    pub next_charge_ts: i64,
    pub active: bool,
    pub bump: u8,
}

#[event]
pub struct PlanCreated {
    pub plan: Pubkey,
    pub authority: Pubkey,
    pub mint: Pubkey,
    pub price: u64,
    pub interval: i64,
}

#[event]
pub struct SubscriptionCreated {
    pub subscription: Pubkey,
    pub subscriber: Pubkey,
    pub plan: Pubkey,
}

#[event]
pub struct PaymentCharged {
    pub subscription: Pubkey,
    pub subscriber: Pubkey,
    pub amount: u64,
    pub next_charge_ts: i64,
}

#[event]
pub struct SubscriptionCancelled {
    pub subscription: Pubkey,
    pub subscriber: Pubkey,
}

#[error_code]
pub enum SubError {
    #[msg("Subscription not active")]
    NotActive,
    #[msg("Charge not yet due")]
    ChargeNotDue,
    #[msg("Invalid treasury")]
    InvalidTreasury,
    #[msg("Overflow")]
    Overflow,
    #[msg("Unauthorized")]
    Unauthorized,
}
