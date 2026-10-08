# Implementation Plan: Payment Features

## Context
This plan implements three payment features requested by the user:
1. Admin payout directly to AlertProche platform
2. Unlock user withdraw button (lower minimum from 100 to 1 XAF for testing)
3. Transaction history (admin filters, per-user admin view, personal history in dashboard)

The backend uses NestJS with MongoDB/Mongoose, and the frontend uses Angular 18 with standalone components and signals. The payment system integrates with digiKUNTZ API for processing transactions.

---

## Feature 1: Admin Payout to Platform

### Backend Changes

- [ ] 1. Add environment variables to `.env` for platform bank details
      **Files:** `c:\code\New folder (3) - Copy\alertproche-api\.env`
      **Action:** Add three new environment variables at the bottom of the file (after DIGIKUNTZ section):
      ```
      # ─── PLATFORM BANK ACCOUNT (for admin payouts) ────────────────────
      PLATFORM_BANK_CODE=MTN
      PLATFORM_ACCOUNT_NUMBER=
      PLATFORM_ACCOUNT_NAME=AlertProche
      ```
      **Verify:** Run `npm run build` in `c:\code\New folder (3) - Copy\alertproche-api` and confirm no errors.

- [ ] 2. Add `POST /admin/payments/payout-to-platform` endpoint in AdminPaymentController
      **Files:** `c:\code\New folder (3) - Copy\alertproche-api\src\payments\payment.controller.ts`
      **Action:** In the `AdminPaymentController` class (after the `markTransactionSuccess` method), add this new endpoint:
      - Accepts body: `{ amount: number, narration?: string }`
      - Protected by `@UseGuards(JwtAuthGuard, RolesGuard)` and `@Roles('Admin')`
      - Reads `PLATFORM_BANK_CODE`, `PLATFORM_ACCOUNT_NUMBER`, `PLATFORM_ACCOUNT_NAME` from `process.env`
      - Validates that all three env vars are set; if not, throw `BadRequestException('Platform bank details not configured.')`
      - Validates `amount >= 1`
      - Calls `this.digikuntz.createPayout(amount, PLATFORM_BANK_CODE, PLATFORM_ACCOUNT_NUMBER, PLATFORM_ACCOUNT_NAME, narration ?? 'Retrait vers AlertProche')` (note: 5 params, narration is last)
      - Creates a Transaction record: `type: 'PAYOUT_REQUEST'`, `status: 'PAYOUT_SUCCESS'`, `transactionRef: 'PLATFORM-PAYOUT-' + Date.now()`, no alertId or userId
      - Returns `{ message: 'Payout effectué vers AlertProche.', transactionId: tx._id, digikuntz: result }`
      - Wrap digikuntz call in try/catch: on error, create tx with `status: 'PAYOUT_ERROR'` and throw `BadRequestException('Échec du payout: ' + err.message)`
      **Verify:** Run `npm run build` in `c:\code\New folder (3) - Copy\alertproche-api` and confirm no TypeScript errors.

### Frontend Changes

- [ ] 3. Add "Retirer vers AlertProche" button and form in admin Paiements tab
      **Files:** `c:\code\New folder (3) - Copy\AlertProche\src\app\features\admin\admin.component.html`
      **Action:** In the `<div *ngIf="activeTab() === 'payments'">` section, after the KPI cards and before "Demandes de retrait en attente", add:
      ```html
      <!-- Admin platform payout -->
      <div class="section-header" style="margin-top:24px">
        <h3><i class="fas fa-building-columns"></i> Retrait vers AlertProche</h3>
      </div>
      <div class="admin-payout-to-platform">
        <button class="btn btn-primary btn-sm" *ngIf="!showPlatformPayoutForm()" (click)="showPlatformPayoutForm.set(true)">
          <i class="fas fa-money-bill-transfer"></i> Retirer vers AlertProche
        </button>
        <div class="platform-payout-form" *ngIf="showPlatformPayoutForm()">
          <div class="form-inline-group">
            <input type="number" class="form-control" placeholder="Montant (XAF)" [(ngModel)]="platformPayoutAmount" min="1">
            <button class="btn btn-primary" [disabled]="platformPayoutLoading()" (click)="executePlatformPayout()">
              <span class="spinner" *ngIf="platformPayoutLoading()"></span>
              <ng-container *ngIf="!platformPayoutLoading()">
                <i class="fas fa-check"></i> Confirmer
              </ng-container>
            </button>
            <button class="btn btn-ghost" (click)="showPlatformPayoutForm.set(false); platformPayoutAmount=null;">Annuler</button>
          </div>
        </div>
      </div>
      ```
      **Verify:** Run `ng build` in `c:\code\New folder (3) - Copy\AlertProche` and confirm no template errors.

- [ ] 4. Add TypeScript logic for platform payout in admin.component.ts
      **Files:** `c:\code\New folder (3) - Copy\AlertProche\src\app\features\admin\admin.component.ts`
      **Action:** 
      - Add three new signal properties after `approveLoading`: 
        ```typescript
        showPlatformPayoutForm = signal(false);
        platformPayoutLoading = signal(false);
        platformPayoutAmount: number | null = null;
        ```
      - Add method `executePlatformPayout()` after `markTransactionSuccess()`:
        ```typescript
        async executePlatformPayout(): Promise<void> {
          if (!this.platformPayoutAmount || this.platformPayoutAmount < 1) {
            alert('Montant invalide (minimum 1 XAF).');
            return;
          }
          this.platformPayoutLoading.set(true);
          try {
            await firstValueFrom(
              this.http.post(`${this.API}/admin/payments/payout-to-platform`, {
                amount: this.platformPayoutAmount,
                narration: 'Retrait administrateur vers compte AlertProche',
              })
            );
            this.showPlatformPayoutForm.set(false);
            this.platformPayoutAmount = null;
            await this.loadPaymentStats();
            this.showSuccess('Payout vers AlertProche effectué avec succès.');
          } catch (err: any) {
            alert(err?.error?.message ?? 'Erreur lors du payout.');
          } finally {
            this.platformPayoutLoading.set(false);
          }
        }
        ```
      **Verify:** Run `ng build` in `c:\code\New folder (3) - Copy\AlertProche` and confirm no TypeScript errors.

---

## Feature 2: Unlock User Withdraw Button

- [ ] 5. Lower minimum withdrawal from 100 to 1 XAF in dashboard withdraw button
      **Files:** `c:\code\New folder (3) - Copy\AlertProche\src\app\features\dashboard\dashboard.component.html`
      **Action:** In the cagnotte section, find the line `[disabled]="c.availableAmount < 100"` and change it to `[disabled]="c.availableAmount <= 0"`. Also find `min="100"` in the payout form input and change it to `min="1"`.
      **Verify:** Run `ng build` in `c:\code\New folder (3) - Copy\AlertProche` and confirm no errors.

- [ ] 6. Lower minimum withdrawal validator from 100 to 1 XAF in dashboard TypeScript
      **Files:** `c:\code\New folder (3) - Copy\AlertProche\src\app\features\dashboard\dashboard.component.ts`
      **Action:** In the constructor, find `this.payoutForm = this.fb.group({ amount: ['', [Validators.required, Validators.min(100)]], ...` and change `Validators.min(100)` to `Validators.min(1)`. Also find the line in `submitPayout()` that says `<span class="form-error" *ngIf="hasError(payoutForm, 'amount', 'min')">Minimum 100 XAF</span>` in the HTML and change it to `Minimum 1 XAF`.
      **Verify:** Run `ng build` in `c:\code\New folder (3) - Copy\AlertProche` and confirm no errors.

- [ ] 7. Lower backend minimum from 15 to 1 XAF in donation and support endpoints
      **Files:** `c:\code\New folder (3) - Copy\alertproche-api\src\payments\payment.controller.ts`
      **Action:** In `initiateDonation()` method, find `if (!alertId || !amount || amount < 15)` and change `15` to `1`. Also update the error message from `'alertId et amount (min 15) sont requis.'` to `'alertId et amount (min 1) sont requis.'`. Do the same in `initiateSupport()`: change `amount < 15` to `amount < 1` and the error message from `'amount (min 15) est requis.'` to `'amount (min 1) est requis.'`.
      **Verify:** Run `npm run build` in `c:\code\New folder (3) - Copy\alertproche-api` and confirm no errors.

---

## Feature 3: Transaction History

### 3a. Add filters (type and status) in admin Paiements tab

- [ ] 8. Add type and status filter dropdowns in admin Paiements tab HTML
      **Files:** `c:\code\New folder (3) - Copy\AlertProche\src\app\features\admin\admin.component.html`
      **Action:** In the "Toutes les transactions" section (before the table), add a filter toolbar:
      ```html
      <div class="table-toolbar" style="margin-bottom:16px">
        <div class="filter-chips-row">
          <label style="font-weight:500;margin-right:8px">Filtres :</label>
          <select class="form-control" style="width:auto;margin-right:8px" [(ngModel)]="txFilterType" (ngModelChange)="loadPaymentStats()">
            <option value="">Tous les types</option>
            <option value="DONATION_ALERT">Dons pour alertes</option>
            <option value="PLATFORM_SUPPORT">Soutien plateforme</option>
            <option value="PAYOUT_REQUEST">Demandes de retrait</option>
          </select>
          <select class="form-control" style="width:auto" [(ngModel)]="txFilterStatus" (ngModelChange)="loadPaymentStats()">
            <option value="">Tous les statuts</option>
            <option value="PENDING">En attente</option>
            <option value="SUCCESS">Réussi</option>
            <option value="FAILED">Échoué</option>
            <option value="PAYOUT_PENDING">Payout en attente</option>
            <option value="PAYOUT_SUCCESS">Payout réussi</option>
            <option value="PAYOUT_ERROR">Payout échoué</option>
          </select>
        </div>
      </div>
      ```
      **Verify:** Run `ng build` in `c:\code\New folder (3) - Copy\AlertProche` and confirm no errors.

- [ ] 9. Add filter signals and update loadPaymentStats to use them
      **Files:** `c:\code\New folder (3) - Copy\AlertProche\src\app\features\admin\admin.component.ts`
      **Action:** 
      - Add two properties after `approveLoading`: `txFilterType = '';` and `txFilterStatus = '';`
      - In `loadPaymentStats()`, update the `allTx` call from `this.http.get<any[]>(\`${this.API}/admin/payments/transactions\`)` to:
        ```typescript
        const params: any = {};
        if (this.txFilterType) params.type = this.txFilterType;
        if (this.txFilterStatus) params.status = this.txFilterStatus;
        const allTx = await firstValueFrom(
          this.http.get<any[]>(`${this.API}/admin/payments/transactions`, { params })
        ).catch(() => []);
        ```
      **Verify:** Run `ng build` in `c:\code\New folder (3) - Copy\AlertProche` and confirm no errors.

### 3b. Add per-user transaction history in admin Users tab

- [ ] 10. Add userId query param support in backend GET /admin/payments/transactions
      **Files:** `c:\code\New folder (3) - Copy\alertproche-api\src\payments\payment.controller.ts`
      **Action:** In `AdminPaymentController.getTransactions()`, add `@Query('userId') userId?: string` to the parameters. Then in the method body, after the existing `if (type)` and `if (status)` checks, add:
      ```typescript
      if (userId) filter['userId'] = new Types.ObjectId(userId);
      ```
      **Verify:** Run `npm run build` in `c:\code\New folder (3) - Copy\alertproche-api` and confirm no errors.

- [ ] 11. Add "Transactions" button per user in admin Users tab HTML
      **Files:** `c:\code\New folder (3) - Copy\AlertProche\src\app\features\admin\admin.component.html`
      **Action:** In the Users tab table, in the Actions column (after the role edit and delete buttons), add:
      ```html
      <button class="btn btn-sm btn-ghost-icon" (click)="viewUserTransactions(user._id)" title="Voir les transactions">
        <i class="fas fa-receipt"></i>
      </button>
      ```
      After the `<table>` closing tag, add a modal/panel to display user transactions:
      ```html
      <div class="user-transactions-panel" *ngIf="selectedUserTransactions()">
        <div class="panel-overlay" (click)="selectedUserTransactions.set(null)"></div>
        <div class="panel-content">
          <div class="panel-header">
            <h3><i class="fas fa-receipt"></i> Transactions</h3>
            <button class="btn btn-ghost btn-sm" (click)="selectedUserTransactions.set(null)">
              <i class="fas fa-xmark"></i>
            </button>
          </div>
          <div class="panel-body">
            <div class="loading-state" *ngIf="userTxLoading()">
              <div class="spinner"></div> Chargement...
            </div>
            <table class="admin-table" *ngIf="!userTxLoading() && selectedUserTransactions()!.length > 0">
              <thead>
                <tr><th>Type</th><th>Montant</th><th>Statut</th><th>Date</th></tr>
              </thead>
              <tbody>
                <tr *ngFor="let t of selectedUserTransactions()">
                  <td><span class="badge">{{ t.type }}</span></td>
                  <td>{{ t.amount | number }} XAF</td>
                  <td><span class="badge">{{ t.status }}</span></td>
                  <td>{{ t.createdAt | date:'dd/MM/yyyy HH:mm' }}</td>
                </tr>
              </tbody>
            </table>
            <div class="empty-table" *ngIf="!userTxLoading() && selectedUserTransactions()!.length === 0">
              <p>Aucune transaction.</p>
            </div>
          </div>
        </div>
      </div>
      ```
      **Verify:** Run `ng build` in `c:\code\New folder (3) - Copy\AlertProche` and confirm no errors.

- [ ] 12. Add TypeScript logic for per-user transactions in admin.component.ts
      **Files:** `c:\code\New folder (3) - Copy\AlertProche\src\app\features\admin\admin.component.ts`
      **Action:** 
      - Add two signals after `platformPayoutLoading`: 
        ```typescript
        selectedUserTransactions = signal<any[] | null>(null);
        userTxLoading = signal(false);
        ```
      - Add method `viewUserTransactions()` after `executePlatformPayout()`:
        ```typescript
        async viewUserTransactions(userId: string): Promise<void> {
          this.userTxLoading.set(true);
          this.selectedUserTransactions.set([]);
          try {
            const tx = await firstValueFrom(
              this.http.get<any[]>(`${this.API}/admin/payments/transactions?userId=${userId}`)
            );
            this.selectedUserTransactions.set(tx);
          } catch {
            this.selectedUserTransactions.set([]);
          } finally {
            this.userTxLoading.set(false);
          }
        }
        ```
      **Verify:** Run `ng build` in `c:\code\New folder (3) - Copy\AlertProche` and confirm no errors.

### 3c. Personal transaction history in user dashboard

- [ ] 13. Add GET /payments/my-transactions endpoint in backend
      **Files:** `c:\code\New folder (3) - Copy\alertproche-api\src\payments\payment.controller.ts`
      **Action:** In `PaymentController` class (after `getMyCagnottes()`), add:
      ```typescript
      @Get('my-transactions')
      @UseGuards(JwtAuthGuard)
      async getMyTransactions(@Request() req: any) {
        const userId = req.user._id ?? req.user.userId;
        
        // Get user's alerts
        const userAlerts = await this.postModel.find({ author_id: new Types.ObjectId(userId) }).select('_id').lean();
        const alertIds = userAlerts.map(p => p._id);
        
        // Find transactions where userId matches OR alertId is in user's alerts
        const filter: any = {
          $or: [
            { userId: new Types.ObjectId(userId) },
            { alertId: { $in: alertIds } }
          ]
        };
        
        return this.transactionModel
          .find(filter)
          .sort({ createdAt: -1 })
          .limit(100)
          .lean();
      }
      ```
      **Verify:** Run `npm run build` in `c:\code\New folder (3) - Copy\alertproche-api` and confirm no errors.

- [ ] 14. Add getMyTransactions method to PaymentService in Angular
      **Files:** `c:\code\New folder (3) - Copy\AlertProche\src\app\core\services\payment.service.ts`
      **Action:** After the `getMyCagnottes()` method, add:
      ```typescript
      /** Mes transactions (paiements + payouts de mes alertes) */
      async getMyTransactions(): Promise<any[]> {
        return firstValueFrom(this.http.get<any[]>(`${this.API}/my-transactions`));
      }
      ```
      **Verify:** Run `ng build` in `c:\code\New folder (3) - Copy\AlertProche` and confirm no errors.

- [ ] 15. Add transaction history display in dashboard Cagnotte tab
      **Files:** `c:\code\New folder (3) - Copy\AlertProche\src\app\features\dashboard\dashboard.component.html`
      **Action:** In the `<div *ngIf="activeTab() === 'cagnotte'">` section, after the payout form panel closing div, add:
      ```html
      <!-- Historique des transactions -->
      <div class="transactions-history" style="margin-top:32px">
        <h3 style="font-size:1rem;font-weight:700;margin-bottom:12px">
          <i class="fas fa-history"></i> Historique des transactions
        </h3>
        <div class="loading-state" *ngIf="txHistoryLoading()">
          <div class="spinner"></div> Chargement...
        </div>
        <table class="admin-table" *ngIf="!txHistoryLoading() && myTransactions().length > 0">
          <thead>
            <tr><th>Type</th><th>Montant</th><th>Statut</th><th>Date</th></tr>
          </thead>
          <tbody>
            <tr *ngFor="let t of myTransactions()">
              <td>
                <span class="badge" [ngClass]="{
                  'badge-green':  t.type === 'DONATION_ALERT',
                  'badge-blue':   t.type === 'PLATFORM_SUPPORT',
                  'badge-orange': t.type === 'PAYOUT_REQUEST'
                }">{{ t.type }}</span>
              </td>
              <td><strong>{{ t.amount | number }} XAF</strong></td>
              <td>
                <span class="badge" [ngClass]="{
                  'badge-green':  t.status === 'SUCCESS' || t.status === 'PAYOUT_SUCCESS',
                  'badge-orange': t.status === 'PENDING' || t.status === 'PAYOUT_PENDING',
                  'badge-red':    t.status === 'FAILED'  || t.status === 'PAYOUT_ERROR'
                }">{{ t.status }}</span>
              </td>
              <td>{{ t.createdAt | date:'dd/MM/yyyy HH:mm' }}</td>
            </tr>
          </tbody>
        </table>
        <div class="empty-state" *ngIf="!txHistoryLoading() && myTransactions().length === 0">
          <div class="empty-icon"><i class="fas fa-receipt"></i></div>
          <p>Aucune transaction.</p>
        </div>
      </div>
      ```
      **Verify:** Run `ng build` in `c:\code\New folder (3) - Copy\AlertProche` and confirm no errors.

- [ ] 16. Add transaction history logic in dashboard.component.ts
      **Files:** `c:\code\New folder (3) - Copy\AlertProche\src\app\features\dashboard\dashboard.component.ts`
      **Action:** 
      - Add two signals after `selectedCagnotte`: 
        ```typescript
        myTransactions = signal<any[]>([]);
        txHistoryLoading = signal(false);
        ```
      - Update the `loadCagnottes()` method to also load transactions:
        ```typescript
        loadCagnottes(): void {
          this.loadingCagnottes.set(true);
          this.txHistoryLoading.set(true);
          Promise.all([
            this.paymentService.getMyCagnottes(),
            this.paymentService.getMyTransactions()
          ]).then(([cagnottes, transactions]) => {
            this.cagnottes.set(cagnottes);
            this.myTransactions.set(transactions);
            this.loadingCagnottes.set(false);
            this.txHistoryLoading.set(false);
          }).catch(() => {
            this.loadingCagnottes.set(false);
            this.txHistoryLoading.set(false);
          });
        }
        ```
      **Verify:** Run `ng build` in `c:\code\New folder (3) - Copy\AlertProche` and confirm no errors.

---

## Final Verification

- [ ] 17. Build and test the complete system
      **Files:** All modified files
      **Action:** 
      - Backend: Run `npm run build` in `c:\code\New folder (3) - Copy\alertproche-api` - must succeed with no errors
      - Frontend: Run `ng build` in `c:\code\New folder (3) - Copy\AlertProche` - must succeed with no errors
      - Start backend with `npm run start:dev` in `c:\code\New folder (3) - Copy\alertproche-api`
      - Start frontend with `ng serve` in `c:\code\New folder (3) - Copy\AlertProche`
      - Test Feature 1: Login as admin, go to admin panel → Paiements tab, click "Retirer vers AlertProche", enter amount, confirm - should succeed or fail gracefully with clear error
      - Test Feature 2: Login as regular user, create a post, donate 1 XAF to it, go to dashboard → Cagnotte tab, verify "Retirer" button is enabled when availableAmount > 0
      - Test Feature 3a: In admin → Paiements tab, use type and status filters - table should update
      - Test Feature 3b: In admin → Users tab, click receipt icon on a user - should show their transactions
      - Test Feature 3c: In user dashboard → Cagnotte tab, scroll down - should see transaction history table
      **Verify:** All features work as described; no console errors; proper error messages on failure.

---

## Risks and Constraints

1. **Environment Variables**: The PLATFORM_BANK_CODE, PLATFORM_ACCOUNT_NUMBER, and PLATFORM_ACCOUNT_NAME must be configured in production `.env` before Feature 1 works. The plan includes validation to prevent runtime errors.

2. **Minimum Amount Change**: Lowering the minimum from 100 to 1 XAF is for testing only. The user mentioned "plutart on reviendra a 100" (later we'll return to 100). Document this change clearly so it can be reverted easily.

3. **Transaction History Performance**: The `getMyTransactions` endpoint limits results to 100 transactions. For users with many transactions, consider adding pagination in a future iteration.

4. **CSS Classes**: The plan assumes existing CSS classes like `.badge-green`, `.badge-blue`, `.badge-orange`, `.badge-red` exist in the admin and dashboard stylesheets. If they don't exist, the badges will still display but without color styling.

5. **Modal/Panel Styling**: The user transactions panel in step 11 assumes CSS classes `.user-transactions-panel`, `.panel-overlay`, `.panel-content`, `.panel-header`, `.panel-body` exist. If not, add basic styling:
   ```css
   .user-transactions-panel { position: fixed; top: 0; left: 0; width: 100%; height: 100%; z-index: 1000; }
   .panel-overlay { position: absolute; top: 0; left: 0; width: 100%; height: 100%; background: rgba(0,0,0,0.5); }
   .panel-content { position: absolute; top: 50%; left: 50%; transform: translate(-50%, -50%); background: white; padding: 24px; border-radius: 8px; max-width: 800px; max-height: 80vh; overflow-y: auto; }
   ```

6. **Types Import**: Ensure `Types` is imported from `mongoose` in payment.controller.ts (already present in existing code).

7. **No Breaking Changes**: All changes are additive - no existing functionality is removed or significantly altered except for the minimum amount validation (which is reversible).

---

## Summary

This plan adds:
- 1 new backend endpoint (POST /admin/payments/payout-to-platform)
- 1 modified backend endpoint (GET /admin/payments/transactions now accepts userId param)
- 1 new backend endpoint (GET /payments/my-transactions)
- 1 new PaymentService method in Angular (getMyTransactions)
- UI components in admin panel for platform payout and user transaction viewing
- UI component in dashboard for personal transaction history
- Filter controls in admin Paiements tab
- Minimum amount reduced from 100 to 1 XAF across donation, support, and withdrawal flows

All changes follow existing patterns: NestJS decorators and guards for backend, Angular signals and HttpClient for frontend, existing CSS utility classes for styling.
