import { useState, useEffect } from 'react';
import { api } from '../lib/api';

interface Tenant {
  tenant_id: string;
  name: string;
  industry: string;
  region: string;
  status: string;
  user_count: number;
  document_count: number;
  created_at: string;
}

export function AdminPanel() {
  const [tenants, setTenants] = useState<Tenant[]>([]);
  const [loading, setLoading] = useState(true);
  const [showCreateTenant, setShowCreateTenant] = useState(false);
  const [showCreateUser, setShowCreateUser] = useState(false);

  // Form states
  const [newTenant, setNewTenant] = useState({
    tenant_id: '',
    name: '',
    industry: '',
    region: ''
  });

  const [newUser, setNewUser] = useState({
    email: '',
    tenant_id: '',
    role: 'consultant',
    temporary_password: 'TempPass123!'
  });

  useEffect(() => {
    loadTenants();
  }, []);

  const loadTenants = async () => {
    setLoading(true);
    try {
      const data = await api.get('/admin/list-tenants');
      setTenants(data.tenants);
    } catch (error) {
      console.error('Failed to load tenants:', error);
      alert('Failed to load tenants');
    } finally {
      setLoading(false);
    }
  };

  const handleCreateTenant = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      await api.post('/admin/create-tenant', newTenant);
      alert(`Tenant ${newTenant.name} created successfully!`);
      setNewTenant({ tenant_id: '', name: '', industry: '', region: '' });
      setShowCreateTenant(false);
      loadTenants();
    } catch (error: any) {
      alert(`Failed to create tenant: ${error.message}`);
    }
  };

  const handleCreateUser = async (e: React.FormEvent) => {
    e.preventDefault();
    try {
      const result = await api.post('/admin/create-user', newUser);
      alert(`User created!\n\nEmail: ${result.email}\nPassword: ${result.temporary_password}\n\nUser must change password on first login.`);
      setNewUser({ email: '', tenant_id: '', role: 'consultant', temporary_password: 'TempPass123!' });
      setShowCreateUser(false);
      loadTenants();
    } catch (error: any) {
      alert(`Failed to create user: ${error.message}`);
    }
  };

  if (loading) {
    return <div className="p-8">Loading tenants...</div>;
  }

  return (
    <div className="p-8 max-w-6xl mx-auto">
      <div className="flex justify-between items-center mb-8">
        <h1 className="text-3xl font-bold">Admin Portal</h1>
        <div className="space-x-4">
          <button
            onClick={() => setShowCreateTenant(true)}
            className="bg-blue-600 text-white px-4 py-2 rounded hover:bg-blue-700"
          >
            + New Tenant
          </button>
          <button
            onClick={() => setShowCreateUser(true)}
            className="bg-green-600 text-white px-4 py-2 rounded hover:bg-green-700"
          >
            + New User
          </button>
        </div>
      </div>

      {/* Create Tenant Modal */}
      {showCreateTenant && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white p-8 rounded-lg max-w-md w-full">
            <h2 className="text-2xl font-bold mb-4">Create New Tenant</h2>
            <form onSubmit={handleCreateTenant} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Tenant ID *</label>
                <input
                  type="text"
                  required
                  placeholder="acme-corp"
                  value={newTenant.tenant_id}
                  onChange={(e) => setNewTenant({ ...newTenant, tenant_id: e.target.value.toLowerCase() })}
                  className="w-full border rounded px-3 py-2"
                />
                <p className="text-xs text-gray-500 mt-1">Lowercase, alphanumeric, dashes/underscores only</p>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Company Name *</label>
                <input
                  type="text"
                  required
                  placeholder="Acme Corporation"
                  value={newTenant.name}
                  onChange={(e) => setNewTenant({ ...newTenant, name: e.target.value })}
                  className="w-full border rounded px-3 py-2"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Industry</label>
                <input
                  type="text"
                  placeholder="Manufacturing"
                  value={newTenant.industry}
                  onChange={(e) => setNewTenant({ ...newTenant, industry: e.target.value })}
                  className="w-full border rounded px-3 py-2"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Region</label>
                <input
                  type="text"
                  placeholder="North America"
                  value={newTenant.region}
                  onChange={(e) => setNewTenant({ ...newTenant, region: e.target.value })}
                  className="w-full border rounded px-3 py-2"
                />
              </div>
              <div className="flex space-x-3 pt-4">
                <button type="submit" className="flex-1 bg-blue-600 text-white py-2 rounded hover:bg-blue-700">
                  Create Tenant
                </button>
                <button
                  type="button"
                  onClick={() => setShowCreateTenant(false)}
                  className="flex-1 bg-gray-300 py-2 rounded hover:bg-gray-400"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Create User Modal */}
      {showCreateUser && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center z-50">
          <div className="bg-white p-8 rounded-lg max-w-md w-full">
            <h2 className="text-2xl font-bold mb-4">Create New User</h2>
            <form onSubmit={handleCreateUser} className="space-y-4">
              <div>
                <label className="block text-sm font-medium mb-1">Email *</label>
                <input
                  type="email"
                  required
                  placeholder="user@example.com"
                  value={newUser.email}
                  onChange={(e) => setNewUser({ ...newUser, email: e.target.value.toLowerCase() })}
                  className="w-full border rounded px-3 py-2"
                />
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Tenant *</label>
                <select
                  required
                  value={newUser.tenant_id}
                  onChange={(e) => setNewUser({ ...newUser, tenant_id: e.target.value })}
                  className="w-full border rounded px-3 py-2"
                >
                  <option value="">Select tenant...</option>
                  {tenants.map(t => (
                    <option key={t.tenant_id} value={t.tenant_id}>
                      {t.name} ({t.tenant_id})
                    </option>
                  ))}
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Role *</label>
                <select
                  required
                  value={newUser.role}
                  onChange={(e) => setNewUser({ ...newUser, role: e.target.value })}
                  className="w-full border rounded px-3 py-2"
                >
                  <option value="consultant">Consultant</option>
                  <option value="client">Client</option>
                  <option value="admin">Admin</option>
                </select>
              </div>
              <div>
                <label className="block text-sm font-medium mb-1">Temporary Password</label>
                <input
                  type="text"
                  value={newUser.temporary_password}
                  onChange={(e) => setNewUser({ ...newUser, temporary_password: e.target.value })}
                  className="w-full border rounded px-3 py-2"
                />
                <p className="text-xs text-gray-500 mt-1">User must change on first login</p>
              </div>
              <div className="flex space-x-3 pt-4">
                <button type="submit" className="flex-1 bg-green-600 text-white py-2 rounded hover:bg-green-700">
                  Create User
                </button>
                <button
                  type="button"
                  onClick={() => setShowCreateUser(false)}
                  className="flex-1 bg-gray-300 py-2 rounded hover:bg-gray-400"
                >
                  Cancel
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* Tenants Table */}
      <div className="bg-white rounded-lg shadow overflow-hidden">
        <table className="w-full">
          <thead className="bg-gray-50">
            <tr>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Tenant</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Industry</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Region</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Users</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Documents</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Status</th>
              <th className="px-6 py-3 text-left text-xs font-medium text-gray-500 uppercase">Created</th>
            </tr>
          </thead>
          <tbody className="divide-y divide-gray-200">
            {tenants.map((tenant) => (
              <tr key={tenant.tenant_id} className="hover:bg-gray-50">
                <td className="px-6 py-4">
                  <div className="font-medium text-gray-900">{tenant.name}</div>
                  <div className="text-sm text-gray-500">{tenant.tenant_id}</div>
                </td>
                <td className="px-6 py-4 text-sm text-gray-500">{tenant.industry || '-'}</td>
                <td className="px-6 py-4 text-sm text-gray-500">{tenant.region || '-'}</td>
                <td className="px-6 py-4 text-sm text-gray-900">{tenant.user_count}</td>
                <td className="px-6 py-4 text-sm text-gray-900">{tenant.document_count}</td>
                <td className="px-6 py-4">
                  <span className={`px-2 py-1 text-xs rounded-full ${
                    tenant.status === 'active' ? 'bg-green-100 text-green-800' : 'bg-gray-100 text-gray-800'
                  }`}>
                    {tenant.status}
                  </span>
                </td>
                <td className="px-6 py-4 text-sm text-gray-500">
                  {tenant.created_at ? new Date(tenant.created_at).toLocaleDateString() : '-'}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {tenants.length === 0 && (
        <div className="text-center py-12 text-gray-500">
          No tenants yet. Click "New Tenant" to create one.
        </div>
      )}
    </div>
  );
}
