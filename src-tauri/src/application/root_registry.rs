//! Own registered workspaces and route only explicitly captured root incarnations.
use crate::application::workspace::Workspace;
use crate::contracts::*;
use std::collections::BTreeMap;

#[derive(Default)]
pub struct RootRegistry {
    roots: BTreeMap<RootId, Workspace>,
}

impl RootRegistry {
    /// Register an already validated workspace without replacing another owner.
    pub fn register(&mut self, workspace: Workspace) -> Result<WorkspaceInfo, WorkspaceError> {
        let info = workspace.info();
        if self.roots.contains_key(&info.scope.root_id) {
            return Err(WorkspaceError::AlreadyExists);
        }
        for document in workspace.documents()? {
            if self
                .roots
                .values()
                .any(|root| root.actor(&document.snapshot.document_id.0).is_ok())
            {
                return Err(WorkspaceError::AlreadyExists);
            }
        }
        self.roots.insert(info.scope.root_id.clone(), workspace);
        Ok(info)
    }

    /// Preserve single-folder switching while refusing to drop unsaved authoritative buffers.
    pub fn replace(&mut self, workspace: Workspace) -> Result<WorkspaceInfo, WorkspaceError> {
        self.ensure_clean()?;
        if let Some(previous) = self.roots.get(&workspace.scope().root_id) {
            if previous.root() != workspace.root() {
                return Err(WorkspaceError::WrongOwner);
            }
        }
        let info = workspace.info();
        self.roots.clear();
        self.roots.insert(info.scope.root_id.clone(), workspace);
        Ok(info)
    }

    /// Refuse root replacement while any owned buffer has unsaved changes.
    pub fn ensure_clean(&self) -> Result<(), WorkspaceError> {
        for workspace in self.roots.values() {
            workspace.ensure_clean()?;
        }
        Ok(())
    }

    /// Resolve an exact root incarnation; never fall back to the active UI folder.
    pub fn workspace_mut(&mut self, scope: &RootScope) -> Result<&mut Workspace, WorkspaceError> {
        let workspace = self
            .roots
            .get_mut(&scope.root_id)
            .ok_or(WorkspaceError::UnknownRoot)?;
        if workspace.scope() != scope {
            return Err(WorkspaceError::StaleRoot);
        }
        Ok(workspace)
    }

    /// Authorize the document owner and captured position before exposing its workspace.
    pub fn document_mut(
        &mut self,
        id: &str,
        location: &DocumentLocation,
    ) -> Result<&mut Workspace, WorkspaceError> {
        if self.roots.values().any(|workspace| {
            workspace.scope().root_id != location.scope.root_id && workspace.actor(id).is_ok()
        }) {
            return Err(WorkspaceError::WrongOwner);
        }
        let workspace = self.workspace_mut(&location.scope)?;
        workspace.validate_location(id, location)?;
        Ok(workspace)
    }

    /// Validate a recovery selection against its current root and recorded relative position.
    pub fn recovery_mut(
        &mut self,
        id: &str,
        location: &DocumentLocation,
    ) -> Result<&mut Workspace, WorkspaceError> {
        let workspace = self.workspace_mut(&location.scope)?;
        let entry = workspace
            .recovery_entries()?
            .into_iter()
            .find(|entry| entry.document_id.0 == id)
            .ok_or(WorkspaceError::NotFound)?;
        if entry.location != *location {
            return Err(WorkspaceError::StaleLocation);
        }
        Ok(workspace)
    }

    /// Poll all registered owners and retain each producing root incarnation.
    pub fn poll(&mut self) -> Vec<RootEvent> {
        self.roots
            .values_mut()
            .flat_map(|workspace| {
                let scope = workspace.scope().clone();
                workspace.poll().into_iter().map(move |event| RootEvent {
                    scope: scope.clone(),
                    event,
                })
            })
            .collect()
    }

    /// Report actual native connectivity across registered workspace owners.
    pub fn has_live_documents(&self) -> bool {
        self.roots.values().any(Workspace::has_live_documents)
    }
}
