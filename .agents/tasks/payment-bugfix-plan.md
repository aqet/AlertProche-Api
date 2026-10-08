# Implementation Plan - Payment Bug Fixes

## Current State Analysis

### Bug 1 - transactionRef extraction (PARTIALLY BROKEN - webhook matching will fail)

**What the digiKUNTZ API actually returns** (confirmed from message 10 logs):
```json
{
  "id": "6ac7500186d5cf3fda4f0479",
  "status": "payin_pending",
  "data": {
    "transactionRef": "IN331#261008081040",
    "paymentLink": "https://checkout.flutterwave.com/...",
    ...
  }
}
```

**Current extraction code** (`digikuntz.service.ts` lines ~70–75):
```typescript
const inner = data['data'] ?? data;
return {
  paymentLink:    inner['paymentLink'] ?? ...,
  transactionRef: inner['transactionRef'] ?? inner['transaction_ref'] ?? inner['ref'] ?? data['id'] ?? `REF-${Date.now()}`,
};
```

**Diagnosis**: The code looks structurally correct - `inner = data['data']` should give the nested object, and `inner['transactionRef']` should be `"IN331#261008081040"`.  
However, the message 10 log shows the stored ref is still `REF-1791447065707` (the fallback), even though the response log confirms `transactionRef` is in `data.data`.  
The most likely cause: the log from message 10 was captured mid-fix (message 9 says "continue"), and the code since then may or may not have been corrected. **The code in the current file appears correct** - `inner['transactionRef']` will hit before the fallback.

**BUT there is a critical secondary problem**: the webhook handler (`handleWebhook`) looks up the transaction by `transactionRef`:
```typescript
const tx = await this.transactionModel.findOne({ transactionRef: ref });
```
If earlier (broken) transactions were stored with `REF-XXXXX` fallback refs, the webhook will send `IN331#...` and find nothing → `raisedAmount` is never incremented. **These old transactions are unrecoverable without a manual DB correction.**

**For new transactions**: if the current extraction code is already working, new transactions will store the correct ref and webhooks will match properly.

**Verdict**: Read the current `digikuntz.service.ts` (already done - it is correct). But the stats are broken because `raisedAmount` was never updated on already-completed payments due to the old fallback ref mismatch. See Bug 3 below.

---

### Bug 2 - Admin payment stat endpoints MISSING (CONFIRMED BROKEN)

**Frontend calls** (in `admin.component.ts` `loadPaymentStats()`):
- `GET /payments/admin/transactions?type=DONATION_ALERT&status=SUCCESS`
- `GET /payments/admin/transactions?type=PLATFORM_SUPPORT&status=SUCCESS`
- `GET /payments/admin/payout-requests`

**Backend reality**:
- `PaymentController` is mounted on `/payments`. It has: `POST donations/initiate`, `POST support/initiate`, `POST payout/request`, `POST webhook`, `GET my-cagnottes`. **None of the three admin endpoints exist here.**
- `AdminPaymentController` is mounted on `/admin/payments`. It has: `POST payout/approve/:id`. The three GET endpoints also **do not exist here**.

**Mismatch**: The frontend calls `/payments/admin/...` but even if these existed, the backend admin controller is on `/admin/payments/...`. There's also a conflict: the frontend calls `POST /admin/payments/payout/approve/:id` for approval (line 320 of admin.component.ts), which IS on the correct route in `AdminPaymentController`. So approval works, but reads are all 404.

**Root cause of "statistiques générales ne voit pas ça"**: These three GET endpoints simply don't exist. Every call returns 404, caught by `.catch(() => [])`, so all stats show 0.

---

### Bug 3 - raisedAmount never updated on post (consequence of Bug 1 for old payments)

**Root cause**: The webhook only increments `raisedAmount` via `$inc` when it finds a transaction matching by `transactionRef`. Old transactions were stored with `REF-XXXXX` fallbacks; the webhook from digiKUNTZ sends `IN331#...` → no match → no update.

**For the test payments already made**: These are stuck at `PENDING` status in MongoDB with wrong refs. The `raisedAmount` on the post is still 0. This requires a manual one-time correction OR a webhook retry mechanism.

---

## Fix Plan

### Fix 1 - Add missing admin GET endpoints to `AdminPaymentController`

- [ ] 1. **Add `GET /admin/payments/transactions`** endpoint to `AdminPaymentController` in `payment.controller.ts`.
        This accepts query params `type` (DONATION_ALERT | PLATFORM_SUPPORT | PAYOUT_REQUEST) and `status` (optional). Returns an array of transactions sorted by `createdAt` descending with `userId` and `alertId` populated (lean, select `amount type status transactionRef createdAt userId alertId`). Requires `JwtAuthGuard + RolesGuard + @Roles('Admin')`.

        **Files**: `alertproche-api/src/payments/payment.controller.ts`

        ```typescript
        @Get('transactions')
        @UseGuards(JwtAuthGuard, RolesGuard)
        @Roles('Admin')
        async getTransactions(
          @Query('type') type?: string,
          @Query('status') status?: string,
        ) {
          const filter: Record<string, any> = {};
          if (type)   filter['type']   = type;
          if (status) filter['status'] = status;
          return this.transactionModel
            .find(filter)
            .sort({ createdAt: -1 })
            .limit(500)
            .lean();
        }
        ```

        Add `Query` to the `@nestjs/common` import.

        **Verify**: `cd alertproche-api && npm run build` - no TypeScript errors.

- [ ] 2. **Add `GET /admin/payments/payout-requests`** endpoint to `AdminPaymentController`.
        Returns all transactions of type `PAYOUT_REQUEST` regardless of status, sorted by `createdAt` desc, populated with `userId` and `alertId`. This is what the frontend uses for the payout approval table.

        **Files**: `alertproche-api/src/payments/payment.controller.ts`

        ```typescript
        @Get('payout-requests')
        @UseGuards(JwtAuthGuard, RolesGuard)
        @Roles('Admin')
        async getPayoutRequests() {
          return this.transactionModel
            .find({ type: 'PAYOUT_REQUEST' })
            .sort({ createdAt: -1 })
            .lean();
        }
        ```

        **Verify**: `cd alertproche-api && npm run build` - no TypeScript errors.

---

### Fix 2 - Verify and harden transactionRef extraction

- [ ] 3. **Confirm the current extraction is correct** and add a fallback log so future regressions are visible.
        In `digikuntz.service.ts`, after extracting `transactionRef`, if it is the `REF-${Date.now()}` fallback, log a warning with the full `inner` object so it is visible in logs.

        **Files**: `alertproche-api/src/payments/digikuntz.service.ts`

        ```typescript
        const inner = data['data'] ?? data;
        const paymentLink    = inner['paymentLink']    ?? inner['payment_link'] ?? inner['link'] ?? inner['url'] ?? '';
        const transactionRef = inner['transactionRef'] ?? inner['transaction_ref'] ?? inner['ref'] ?? data['id'];
        if (!transactionRef) {
          this.logger.warn(`[digiKUNTZ] transactionRef not found in response. inner=${JSON.stringify(inner)} full=${JSON.stringify(data)}`);
        }
        return {
          paymentLink,
          transactionRef: transactionRef ?? `REF-${Date.now()}`,
        };
        ```

        **Verify**: `cd alertproche-api && npm run build` - no TypeScript errors.

---

### Fix 3 - Recover raisedAmount for already-completed payments

The payments that went through with `REF-XXXXX` refs will never match a webhook. Two options - implement option A:

- [ ] 4. **Add a one-time admin endpoint `POST /admin/payments/reconcile-pending`** that:
        1. Finds all transactions with `status = 'PENDING'` AND `transactionRef` starting with `REF-` AND `type = 'DONATION_ALERT'`.
        2. For each, checks if the transaction is older than 10 minutes (reasonable confirmation window).
        3. Marks them `FAILED` (not auto-SUCCESS - we cannot verify payment without the real ref).

        Additionally, create a separate endpoint `POST /admin/payments/mark-success/:transactionId` that an admin can call manually to mark a specific transaction as SUCCESS and trigger the `raisedAmount` increment. This gives the admin a safe manual override for the few test payments that succeeded.

        **Files**: `alertproche-api/src/payments/payment.controller.ts`

        ```typescript
        // Mark a specific pending transaction as SUCCESS (manual admin recovery)
        @Post('mark-success/:transactionId')
        @UseGuards(JwtAuthGuard, RolesGuard)
        @Roles('Admin')
        @HttpCode(HttpStatus.OK)
        async markTransactionSuccess(@Param('transactionId') transactionId: string) {
          const tx = await this.transactionModel.findById(transactionId);
          if (!tx) throw new NotFoundException('Transaction introuvable.');
          if (tx.status === 'SUCCESS') return { message: 'Déjà marquée SUCCESS.' };
          
          tx.status = 'SUCCESS';
          await tx.save();

          if (tx.type === 'DONATION_ALERT' && tx.alertId) {
            await this.postModel.findByIdAndUpdate(tx.alertId, {
              $inc: { raisedAmount: tx.amount },
            });
            this.logger.log(`[manual] raisedAmount updated for alert ${tx.alertId} +${tx.amount}`);
          }
          return { message: 'Transaction marquée SUCCESS.', transactionId: tx._id };
        }
        ```

        **Verify**: `cd alertproche-api && npm run build` - no TypeScript errors.

---

### Fix 4 - `AdminPaymentController` needs `postModel` injected

- [ ] 5. **The new `mark-success` endpoint needs `postModel`**. Currently `AdminPaymentController` does NOT inject `PostModel`. Add it.

        **Files**: `alertproche-api/src/payments/payment.controller.ts`

        In `AdminPaymentController` constructor, add:
        ```typescript
        @InjectModel(PostModel.name)
        private readonly postModel: Model<PostDocument>,
        ```

        The `PostModel` import already exists in the file as `Post as PostModel`.

        **Verify**: `cd alertproche-api && npm run build` - no TypeScript errors.

---

### Fix 5 - Frontend validation inconsistency (minor)

- [ ] 6. **Fix the minimum-amount inconsistency** in the two modal components.
        Currently `isValid` checks `>= 15` but `submit()` checks `>= 1`, and the placeholder says "min. 100 XAF". The user asked to set minimum to 15 for testing. Make `isValid` and `submit()` consistent at `>= 15` in both modals.

        **Files**:
        - `AlertProche/src/app/shared/components/donation-modal/donation-modal.component.ts` - both `isValid` getter and `submit()` guard already check `>= 15` / `>= 1` respectively. Align both to `>= 15`.
        - `AlertProche/src/app/shared/components/platform-support-modal/platform-support-modal.component.ts` - same fix.

        Change in both files:
        - `isValid`: keep `>= 15`
        - `submit()` guard: change `< 1` to `< 15`
        - placeholder text: change "min. 100 XAF" to "min. 15 XAF" (temporary, user confirmed will revert to 100 later)

        **Verify**: `cd AlertProche && ng build --configuration development` - no TypeScript errors.

---

## File Map

| File | Changes |
|------|---------|
| `alertproche-api/src/payments/payment.controller.ts` | Add `Query` import; add 4 new endpoints to `AdminPaymentController`: `GET transactions`, `GET payout-requests`, `POST mark-success/:id`; inject `postModel` into `AdminPaymentController`. |
| `alertproche-api/src/payments/digikuntz.service.ts` | Harden extraction with fallback warning log. |
| `AlertProche/src/app/shared/components/donation-modal/donation-modal.component.ts` | Align min-amount to 15 in `submit()`. |
| `AlertProche/src/app/shared/components/platform-support-modal/platform-support-modal.component.ts` | Align min-amount to 15 in `submit()`. |

---

## Verification Steps

After all changes:

1. **Backend build**: `cd "c:\code\New folder (3) - Copy\alertproche-api" && npm run build`  
   Expected: exit code 0, no TypeScript compilation errors.

2. **Frontend build**: `cd "c:\code\New folder (3) - Copy\AlertProche" && ng build --configuration development`  
   Expected: exit code 0, no compilation errors.

3. **Manual functional test**:
   - Navigate to admin panel → Payments tab
   - `GET /admin/payments/transactions?type=DONATION_ALERT&status=SUCCESS` should return an array (not 404)
   - `GET /admin/payments/payout-requests` should return an array (not 404)
   - Payment stats totals should now show non-zero if any SUCCESS transactions exist

4. **Test a new donation**:
   - Initiate a donation → check server log for `[digiKUNTZ] response →` to confirm `transactionRef` is `IN331#...` (not `REF-`)
   - The stored transaction in DB should have `transactionRef = "IN331#..."`
   - After payment completion, digiKUNTZ webhook fires → `raisedAmount` on the post increments

5. **Recover old payments** (manual admin step, not automated):
   - Call `POST /admin/payments/mark-success/:transactionId` for the transaction IDs that are stuck as PENDING with REF- refs and are confirmed paid
   - Verify `raisedAmount` on the corresponding post/alert increments

---

## Root Cause Summary

| Bug | Root cause | Status |
|-----|-----------|--------|
| Stats show 0 donations/support | `GET /payments/admin/transactions` and `GET /payments/admin/payout-requests` endpoints don't exist in the backend | **CONFIRMED - fix in items 1–2** |
| Post's `raisedAmount` stays 0 | Old transactions stored with `REF-` fallback refs; webhook can't match them | **CONFIRMED - manual recovery in item 4** |
| transactionRef extraction | Structurally correct in current code; any remaining mismatch is due to old data, not new code | **OK for new payments - harden logs in item 3** |
| Min-amount inconsistency | `isValid` checks `>= 15` but `submit()` checks `< 1` | **Minor - fix in item 6** |
