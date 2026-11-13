import { BrowserRouter, Routes, Route } from 'react-router-dom';
import { AuthProvider } from '@/auth/AuthContext';
import ProtectedRoute from '@/auth/ProtectedRoute';
import LoginPage from '@/auth/LoginPage';
import AppLayout from '@/layout/AppLayout';
import DashboardPage from '@/features/dashboard/DashboardPage';
import CustomersListPage from '@/features/customers/CustomersListPage';
import CustomerStatementPage from '@/features/customers/CustomerStatementPage';
import SuppliersListPage from '@/features/suppliers/SuppliersListPage';
import ItemsListPage from '@/features/catalog/ItemsListPage';
import ManufacturingHomePage from '@/features/manufacturing/ManufacturingHomePage';
import ActivitiesListPage from '@/features/manufacturing/ActivitiesListPage';
import BomsListPage from '@/features/manufacturing/BomsListPage';
import BomCreatePage from '@/features/manufacturing/BomCreatePage';
import BomDetailPage from '@/features/manufacturing/BomDetailPage';
import ProductionOrdersListPage from '@/features/manufacturing/ProductionOrdersListPage';
import ProductionOrderCreatePage from '@/features/manufacturing/ProductionOrderCreatePage';
import ProductionOrderDetailPage from '@/features/manufacturing/ProductionOrderDetailPage';
import StocktakesListPage from '@/features/stocktake/StocktakesListPage';
import StocktakeCreatePage from '@/features/stocktake/StocktakeCreatePage';
import StocktakeDetailPage from '@/features/stocktake/StocktakeDetailPage';
import SupplierStatementPage from '@/features/suppliers/SupplierStatementPage';
import SalesInvoicesListPage from '@/features/salesInvoices/SalesInvoicesListPage';
import SalesInvoiceCreatePage from '@/features/salesInvoices/SalesInvoiceCreatePage';
import SalesInvoiceDetailPage from '@/features/salesInvoices/SalesInvoiceDetailPage';
import CustomerPaymentsListPage from '@/features/customerPayments/CustomerPaymentsListPage';
import CustomerPaymentCreatePage from '@/features/customerPayments/CustomerPaymentCreatePage';
import CustomerPaymentDetailPage from '@/features/customerPayments/CustomerPaymentDetailPage';
import SupplierPaymentsListPage from '@/features/supplierPayments/SupplierPaymentsListPage';
import SupplierPaymentCreatePage from '@/features/supplierPayments/SupplierPaymentCreatePage';
import SupplierPaymentDetailPage from '@/features/supplierPayments/SupplierPaymentDetailPage';
import PluginsPage from '@/plugins/PluginsPage';
import BackendPluginPage from '@/plugins/BackendPluginPage';
import ExternalPluginPage from '@/plugins/ExternalPluginPage';
import TextileHomePage from '@/features/textile/TextileHomePage';
import TextileSetupPage from '@/features/textile/TextileSetupPage';
import MachinesPage from '@/features/textile/MachinesPage';
import RollsPage from '@/features/textile/RollsPage';
import QualityPage from '@/features/textile/QualityPage';
import MaintenancePage from '@/features/textile/MaintenancePage';
import TextileReportsPage from '@/features/textile/TextileReportsPage';
import TextileToolsPage from '@/features/textile/TextileToolsPage';
import OrderTextilePage from '@/features/textile/OrderTextilePage';
import WeavingPage from '@/features/textile/WeavingPage';
import FibersPage from '@/features/textile/FibersPage';
import DyeingPage from '@/features/textile/DyeingPage';
import TollPage from '@/features/textile/TollPage';
import CostRatesPage from '@/features/textile/CostRatesPage';
import SchedulePage from '@/features/textile/SchedulePage';
import SalesTrackingPage from '@/features/textile/SalesTrackingPage';
import DefectsPage from '@/features/textile/DefectsPage';
import ItemSpecsPage from '@/features/textile/ItemSpecsPage';
import DeliveryPage from '@/features/textile/DeliveryPage';
import UtilitiesPage from '@/features/textile/UtilitiesPage';
import BlendPage from '@/features/textile/BlendPage';
import TracePage from '@/features/textile/TracePage';
import ClaimsPage from '@/features/textile/ClaimsPage';
import FabricStockPage from '@/features/textile/FabricStockPage';
import CostCardPage from '@/features/textile/CostCardPage';
import LotIssuePage from '@/features/textile/LotIssuePage';
import SalesPaymentPage from '@/features/textile/SalesPaymentPage';
import LotsPage from '@/features/textile/LotsPage';
import PriceDeviationPage from '@/features/textile/PriceDeviationPage';
import CriticalPage from '@/features/textile/CriticalPage';
import CurrenciesPage from '@/features/textile/CurrenciesPage';
import ProfitabilityPage from '@/features/textile/ProfitabilityPage';
import SimulatorPage from '@/features/textile/SimulatorPage';
import AttendancePage from '@/features/textile/AttendancePage';
import PayrollPage from '@/features/textile/PayrollPage';
import WorkforcePage from '@/features/textile/WorkforcePage';
import SubcontractPage from '@/features/textile/SubcontractPage';
import LabelsPage from '@/features/textile/LabelsPage';
import ProductionReportsPage from '@/features/textile/ProductionReportsPage';
import BackupPage from '@/features/backup/BackupPage';
import SettingsPage from '@/features/settings/SettingsPage';
import UsersPage from '@/features/admin/UsersPage';
import NotificationsPage from '@/notifications/NotificationsPage';
import SalesReturnsListPage from '@/features/salesReturns/SalesReturnsListPage';
import SalesReturnCreatePage from '@/features/salesReturns/SalesReturnCreatePage';
import SalesReturnDetailPage from '@/features/salesReturns/SalesReturnDetailPage';
import PurchaseReturnsListPage from '@/features/purchaseReturns/PurchaseReturnsListPage';
import PurchaseReturnCreatePage from '@/features/purchaseReturns/PurchaseReturnCreatePage';
import PurchaseReturnDetailPage from '@/features/purchaseReturns/PurchaseReturnDetailPage';
import ReportsHomePage from '@/features/reports/ReportsHomePage';
import TrialBalancePage from '@/features/reports/TrialBalancePage';
import InventoryValuationPage from '@/features/reports/InventoryValuationPage';
import SalesSummaryPage from '@/features/reports/SalesSummaryPage';
import PurchaseSummaryPage from '@/features/reports/PurchaseSummaryPage';
import PeriodClosingPage from '@/features/closing/PeriodClosingPage';
import WithholdingTaxPage from '@/features/wht/WithholdingTaxPage';
import YarnLedgerPage from '@/features/yarn/YarnLedgerPage';
import LandedCostsPage from '@/features/landed/LandedCostsPage';
import FixedAssetsPage from '@/features/assets/FixedAssetsPage';
import FinancialReportsPage from '@/features/reports/FinancialReportsPage';
import GoodsReceiptsListPage from '@/features/goodsReceipts/GoodsReceiptsListPage';
import GoodsReceiptCreatePage from '@/features/goodsReceipts/GoodsReceiptCreatePage';
import GoodsReceiptDetailPage from '@/features/goodsReceipts/GoodsReceiptDetailPage';
import PurchaseInvoicesListPage from '@/features/purchaseInvoices/PurchaseInvoicesListPage';
import PurchaseInvoiceCreatePage from '@/features/purchaseInvoices/PurchaseInvoiceCreatePage';
import PurchaseInvoiceDetailPage from '@/features/purchaseInvoices/PurchaseInvoiceDetailPage';
import SalesInvoicePrintPage from '@/features/salesInvoices/SalesInvoicePrintPage';
import PurchaseInvoicePrintPage from '@/features/purchaseInvoices/PurchaseInvoicePrintPage';
import TreasuryHomePage from '@/features/treasury/TreasuryHomePage';
import SafesListPage from '@/features/treasury/SafesListPage';
import TreasuryTransactionsListPage from '@/features/treasury/TreasuryTransactionsListPage';
import TreasuryTransactionCreatePage from '@/features/treasury/TreasuryTransactionCreatePage';
import TreasuryTransactionDetailPage from '@/features/treasury/TreasuryTransactionDetailPage';
import TreasuryTransfersListPage from '@/features/treasury/TreasuryTransfersListPage';
import TreasuryTransferCreatePage from '@/features/treasury/TreasuryTransferCreatePage';
import TreasuryTransferDetailPage from '@/features/treasury/TreasuryTransferDetailPage';
import ChecksListPage from '@/features/treasury/ChecksListPage';
import CheckCreatePage from '@/features/treasury/CheckCreatePage';
import CheckDetailPage from '@/features/treasury/CheckDetailPage';
import ReconciliationsListPage from '@/features/treasury/ReconciliationsListPage';
import ReconciliationCreatePage from '@/features/treasury/ReconciliationCreatePage';
import ReconciliationDetailPage from '@/features/treasury/ReconciliationDetailPage';

export default function App() {
  return (
    <BrowserRouter>
      <AuthProvider>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route element={<ProtectedRoute />}>
            <Route path="/sales/invoices/:id/print" element={<SalesInvoicePrintPage />} />
            <Route path="/purchasing/invoices/:id/print" element={<PurchaseInvoicePrintPage />} />
            <Route element={<AppLayout />}>
              <Route path="/" element={<DashboardPage />} />
              <Route path="/customers" element={<CustomersListPage />} />
              <Route path="/customers/:id/statement" element={<CustomerStatementPage />} />
              <Route path="/suppliers" element={<SuppliersListPage />} />
              <Route path="/items" element={<ItemsListPage />} />
              <Route path="/manufacturing" element={<ManufacturingHomePage />} />
              <Route path="/manufacturing/activities" element={<ActivitiesListPage />} />
              <Route path="/manufacturing/boms" element={<BomsListPage />} />
              <Route path="/manufacturing/boms/new" element={<BomCreatePage />} />
              <Route path="/manufacturing/boms/:id" element={<BomDetailPage />} />
              <Route path="/manufacturing/orders" element={<ProductionOrdersListPage />} />
              <Route path="/manufacturing/orders/new" element={<ProductionOrderCreatePage />} />
              <Route path="/manufacturing/orders/:id" element={<ProductionOrderDetailPage />} />
              <Route path="/inventory/stocktakes" element={<StocktakesListPage />} />
              <Route path="/inventory/stocktakes/new" element={<StocktakeCreatePage />} />
              <Route path="/inventory/stocktakes/:id" element={<StocktakeDetailPage />} />
              <Route path="/suppliers/:id/statement" element={<SupplierStatementPage />} />
              <Route path="/sales/invoices" element={<SalesInvoicesListPage />} />
              <Route path="/sales/invoices/new" element={<SalesInvoiceCreatePage />} />
              <Route path="/sales/invoices/:id" element={<SalesInvoiceDetailPage />} />
              <Route path="/purchasing/receipts" element={<GoodsReceiptsListPage />} />
              <Route path="/purchasing/receipts/new" element={<GoodsReceiptCreatePage />} />
              <Route path="/purchasing/receipts/:id" element={<GoodsReceiptDetailPage />} />
              <Route path="/purchasing/invoices" element={<PurchaseInvoicesListPage />} />
              <Route path="/purchasing/invoices/new" element={<PurchaseInvoiceCreatePage />} />
              <Route path="/purchasing/invoices/:id" element={<PurchaseInvoiceDetailPage />} />
              <Route path="/sales/payments" element={<CustomerPaymentsListPage />} />
              <Route path="/sales/payments/new" element={<CustomerPaymentCreatePage />} />
              <Route path="/sales/payments/:id" element={<CustomerPaymentDetailPage />} />
              <Route path="/purchasing/payments" element={<SupplierPaymentsListPage />} />
              <Route path="/purchasing/payments/new" element={<SupplierPaymentCreatePage />} />
              <Route path="/purchasing/payments/:id" element={<SupplierPaymentDetailPage />} />
              <Route path="/plugins" element={<PluginsPage />} />
              <Route path="/plugins/:name" element={<BackendPluginPage />} />
              <Route path="/ext/:pluginId" element={<ExternalPluginPage />} />
              <Route path="/settings" element={<SettingsPage />} />
              <Route path="/settings/users" element={<UsersPage />} />
              <Route path="/textile" element={<TextileHomePage />} />
              <Route path="/textile/setup" element={<TextileSetupPage />} />
              <Route path="/textile/machines" element={<MachinesPage />} />
              <Route path="/textile/rolls" element={<RollsPage />} />
              <Route path="/textile/quality" element={<QualityPage />} />
              <Route path="/textile/maintenance" element={<MaintenancePage />} />
              <Route path="/textile/reports" element={<TextileReportsPage />} />
              <Route path="/textile/tools" element={<TextileToolsPage />} />
              <Route path="/textile/weaving" element={<WeavingPage />} />
              <Route path="/textile/fibers" element={<FibersPage />} />
              <Route path="/textile/dyeing" element={<DyeingPage />} />
              <Route path="/textile/toll" element={<TollPage />} />
              <Route path="/textile/cost-rates" element={<CostRatesPage />} />
              <Route path="/textile/production-reports" element={<ProductionReportsPage />} />
              <Route path="/textile/orders/:id" element={<OrderTextilePage />} />
              <Route path="/textile/schedule" element={<SchedulePage />} />
              <Route path="/textile/sales-tracking" element={<SalesTrackingPage />} />
              <Route path="/textile/defects" element={<DefectsPage />} />
              <Route path="/textile/specs" element={<ItemSpecsPage />} />
              <Route path="/textile/delivery" element={<DeliveryPage />} />
              <Route path="/textile/utilities" element={<UtilitiesPage />} />
              <Route path="/textile/blend" element={<BlendPage />} />
              <Route path="/textile/trace" element={<TracePage />} />
              <Route path="/textile/claims" element={<ClaimsPage />} />
              <Route path="/textile/fabric-stock" element={<FabricStockPage />} />
              <Route path="/textile/cost-card" element={<CostCardPage />} />
              <Route path="/textile/profitability" element={<ProfitabilityPage />} />
              <Route path="/textile/lot-issue" element={<LotIssuePage />} />
              <Route path="/textile/sales-payment" element={<SalesPaymentPage />} />
              <Route path="/textile/lots" element={<LotsPage />} />
              <Route path="/textile/price-deviation" element={<PriceDeviationPage />} />
              <Route path="/textile/critical" element={<CriticalPage />} />
              <Route path="/textile/currencies" element={<CurrenciesPage />} />
              <Route path="/textile/simulator" element={<SimulatorPage />} />
              <Route path="/textile/attendance" element={<AttendancePage />} />
              <Route path="/textile/payroll" element={<PayrollPage />} />
              <Route path="/textile/workforce" element={<WorkforcePage />} />
              <Route path="/textile/subcontract" element={<SubcontractPage />} />
              <Route path="/textile/labels" element={<LabelsPage />} />
              <Route path="/backup" element={<BackupPage />} />
              <Route path="/notifications" element={<NotificationsPage />} />
              <Route path="/sales/returns" element={<SalesReturnsListPage />} />
              <Route path="/sales/returns/new" element={<SalesReturnCreatePage />} />
              <Route path="/sales/returns/:id" element={<SalesReturnDetailPage />} />
              <Route path="/purchasing/returns" element={<PurchaseReturnsListPage />} />
              <Route path="/purchasing/returns/new" element={<PurchaseReturnCreatePage />} />
              <Route path="/purchasing/returns/:id" element={<PurchaseReturnDetailPage />} />
              <Route path="/treasury" element={<TreasuryHomePage />} />
              <Route path="/treasury/safes" element={<SafesListPage />} />
              <Route path="/treasury/transactions" element={<TreasuryTransactionsListPage />} />
              <Route path="/treasury/transactions/new" element={<TreasuryTransactionCreatePage />} />
              <Route path="/treasury/transactions/:id" element={<TreasuryTransactionDetailPage />} />
              <Route path="/treasury/transfers" element={<TreasuryTransfersListPage />} />
              <Route path="/treasury/transfers/new" element={<TreasuryTransferCreatePage />} />
              <Route path="/treasury/transfers/:id" element={<TreasuryTransferDetailPage />} />
              <Route path="/treasury/checks" element={<ChecksListPage />} />
              <Route path="/treasury/checks/new" element={<CheckCreatePage />} />
              <Route path="/treasury/checks/:id" element={<CheckDetailPage />} />
              <Route path="/treasury/reconciliations" element={<ReconciliationsListPage />} />
              <Route path="/treasury/reconciliations/new" element={<ReconciliationCreatePage />} />
              <Route path="/treasury/reconciliations/:id" element={<ReconciliationDetailPage />} />
              <Route path="/reports" element={<ReportsHomePage />} />
              <Route path="/reports/trial-balance" element={<TrialBalancePage />} />
              <Route path="/reports/inventory-valuation" element={<InventoryValuationPage />} />
              <Route path="/reports/sales-summary" element={<SalesSummaryPage />} />
              <Route path="/reports/purchase-summary" element={<PurchaseSummaryPage />} />
              <Route path="/accounting/closing" element={<PeriodClosingPage />} />
              <Route path="/accounting/wht" element={<WithholdingTaxPage />} />
              <Route path="/textile/yarn-ledger" element={<YarnLedgerPage />} />
              <Route path="/landed-costs" element={<LandedCostsPage />} />
              <Route path="/assets" element={<FixedAssetsPage />} />
              <Route path="/reports/financial" element={<FinancialReportsPage />} />
            </Route>
          </Route>
        </Routes>
      </AuthProvider>
    </BrowserRouter>
  );
}
